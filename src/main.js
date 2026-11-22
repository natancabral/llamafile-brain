'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { LlamafileServer, portFree } = require('./core/llamafile');
const { checkExternal } = require('./core/client');
const { BrainDB } = require('./core/db');
const { indexFolders, makeIgnore, SKIP_DIRS } = require('./core/indexer');
const { ask, retrieve } = require('./core/rag');
const { runEval } = require('./core/evalset');
const { ocrStatus } = require('./core/ocr');
const deps = require('./core/deps');
const { estimateTokens } = require('./core/tokens');
const { spawn } = require('node:child_process');
const I18N = require('./shared/i18n');
const t = I18N.t;

const SERVERS = ['chat', 'embed', 'rerank'];

const DEFAULTS = {
  chat: { mode: 'spawn', gpu: 'auto', file: '', port: 8080, args: '-c 8192', url: 'http://127.0.0.1:8080', model: 'local' },
  embed: { mode: 'spawn', gpu: 'auto', file: '', port: 8081, args: '--pooling mean', url: 'http://127.0.0.1:8081', model: 'local' },
  rerank: {
    enabled: false, candidates: 20, mode: 'spawn', gpu: 'auto', file: '', port: 8082,
    args: '--embedding --pooling rank --reranking', url: 'http://127.0.0.1:8082', model: 'local',
  },
  folders: [], // document folders the app may read
  brainDir: '', // personal notes folder (.md); memory is exported here as memory.md
  dbDir: '', // folder holding brain.sqlite ('' = default inside app data)
  ignore: [], // names / globs to skip, e.g. "prontuario", "*.png"
  ocr: { enabled: false, lang: 'por+eng', maxPages: 30 },
  autoIndex: true,
  useFiles: true,
  maxInputTokens: 1000, // typed-question limit (estimated)
  language: 'en', // UI/message language: en | pt | es
  topK: 6,
  contextChars: 6000,
  historyTurns: 3,
  temperature: 0.2,
  summaryMaxFiles: 40,
  hybrid: { vectorWeight: 0.6 },
  memory: { enabled: true, maxChars: 1500 },
  profile: '',
  evalSet: '',
};

let win;
let settings;
let db = null;
let dbError = null;
let userDir;
let indexAbort = null;
let chatAbort = null;
let indexRunning = false;
let indexPending = false;
let lastMemKey = null;
let watchers = [];
let watchTimer = null;

const servers = Object.fromEntries(
  SERVERS.map((n) => [n, new LlamafileServer({ name: n, onLog: (src, t) => send('log', { source: src, text: t }) })]),
);

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
const log = (source, text) => send('log', { source, text });

// ---------------------------------------------------------------- settings
function merge(base, saved) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(saved || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') out[k] = { ...out[k], ...v };
    else out[k] = v;
  }
  return out;
}
function loadSettings() {
  try {
    return merge(DEFAULTS, JSON.parse(fs.readFileSync(path.join(userDir, 'settings.json'), 'utf8')));
  } catch {
    return structuredClone(DEFAULTS);
  }
}
function saveSettings() {
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify(settings, null, 2));
}
const num = (v, d, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const str = (v, d = '') => (typeof v === 'string' ? v : d);

function patchServer(which, p) {
  const s = settings[which];
  if ('mode' in p) s.mode = p.mode === 'external' ? 'external' : 'spawn';
  if ('file' in p) s.file = str(p.file, s.file);
  if ('args' in p) s.args = str(p.args, s.args);
  if ('gpu' in p) s.gpu = ['auto', 'on', 'off'].includes(p.gpu) ? p.gpu : 'auto';
  if ('model' in p) s.model = str(p.model, s.model) || 'local';
  if ('port' in p) s.port = num(p.port, s.port, 1024, 65535);
  if ('url' in p && s.mode === 'external') s.url = str(p.url, s.url).replace(/\/+$/, '');
  if (s.mode === 'spawn') s.url = `http://127.0.0.1:${s.port}`;
}

function applySettingsPatch(p = {}) {
  for (const k of SERVERS) if (p[k]) patchServer(k, p[k]);
  if (p.rerank) {
    if ('enabled' in p.rerank) settings.rerank.enabled = !!p.rerank.enabled;
    if ('candidates' in p.rerank) settings.rerank.candidates = num(p.rerank.candidates, 20, 5, 100);
  }
  if ('language' in p) settings.language = I18N.setLang(p.language);
  for (const k of ['useFiles', 'autoIndex']) if (k in p) settings[k] = !!p[k];
  if ('maxInputTokens' in p) settings.maxInputTokens = num(p.maxInputTokens, settings.maxInputTokens, 50, 32000);
  if ('topK' in p) settings.topK = num(p.topK, settings.topK, 1, 20);
  if ('contextChars' in p) settings.contextChars = num(p.contextChars, settings.contextChars, 1000, 60000);
  if ('historyTurns' in p) settings.historyTurns = num(p.historyTurns, settings.historyTurns, 0, 10);
  if ('temperature' in p) settings.temperature = num(p.temperature, settings.temperature, 0, 2);
  if ('summaryMaxFiles' in p) settings.summaryMaxFiles = num(p.summaryMaxFiles, 40, 1, 500);
  if (p.hybrid && 'vectorWeight' in p.hybrid) settings.hybrid.vectorWeight = num(p.hybrid.vectorWeight, 0.6, 0, 1);
  if (p.memory) {
    if ('enabled' in p.memory) settings.memory.enabled = !!p.memory.enabled;
    if ('maxChars' in p.memory) settings.memory.maxChars = num(p.memory.maxChars, 1500, 200, 8000);
  }
  if ('profile' in p) settings.profile = str(p.profile).slice(0, 1500);
  if ('evalSet' in p) settings.evalSet = str(p.evalSet).slice(0, 20000);
  if (Array.isArray(p.ignore)) {
    settings.ignore = p.ignore.map((x) => str(x).trim()).filter(Boolean).slice(0, 100);
  }
  if (p.ocr) {
    if ('enabled' in p.ocr) settings.ocr.enabled = !!p.ocr.enabled;
    if ('lang' in p.ocr && /^[A-Za-z_+]{2,40}$/.test(p.ocr.lang)) settings.ocr.lang = p.ocr.lang;
    if ('maxPages' in p.ocr) settings.ocr.maxPages = num(p.ocr.maxPages, 30, 1, 300);
  }
  saveSettings();
  restartWatchers();
}

// ---------------------------------------------------------------- database
function dbFile() {
  return path.join(settings.dbDir || path.join(userDir, 'brain'), 'brain.sqlite');
}
function openDb() {
  if (db) db.close();
  db = null;
  dbError = null;
  try {
    db = new BrainDB(dbFile());
  } catch (e) {
    dbError = e.message;
    log('db', `Erro ao abrir o banco: ${e.message}`);
  }
  lastMemKey = null;
}
function getDb() {
  if (!db) throw new Error(dbError || t('main.noDb'));
  return db;
}
function fullStats() {
  if (!db) return { files: 0, chunks: 0, memories: 0, dim: 0, dbFile: dbFile(), error: dbError };
  return { ...db.stats(), dbFile: dbFile() };
}

// ---------------------------------------------------------------- roots / memory export
function rootsList() {
  const roots = [];
  if (settings.brainDir && fs.existsSync(settings.brainDir)) roots.push({ dir: settings.brainDir, kind: 'brain' });
  for (const f of settings.folders) if (fs.existsSync(f)) roots.push({ dir: f, kind: 'doc' });
  return roots;
}
function purgeOutsideRoots() {
  if (!db) return;
  const roots = rootsList().map((r) => r.dir);
  for (const f of db.listFiles()) {
    if (!roots.some((r) => f.path === r || f.path.startsWith(r + path.sep))) db.removeFile(f.path);
  }
}

/** Writes <brainDir>/memory.md when the memory changed. Returns true if the memory changed. */
function exportMemory() {
  if (!db) return false;
  const list = db.listMemories();
  const key = JSON.stringify(list.map((m) => [m.id, m.text]));
  if (key === lastMemKey) return false;
  lastMemKey = key;
  if (settings.brainDir && fs.existsSync(settings.brainDir)) {
    const md = t('main.memHeader') + [...list].reverse().map((m) => `- ${m.text}`).join('\n') + '\n';
    try {
      fs.writeFileSync(path.join(settings.brainDir, 'memory.md'), md);
    } catch (e) {
      log('memory', t('main.memWriteFail', { e: e.message }));
    }
  }
  return true;
}

// ---------------------------------------------------------------- indexing + auto reindex
async function runIndex({ auto = false } = {}) {
  const database = getDb();
  if (indexRunning) {
    indexPending = true;
    return null;
  }
  const roots = rootsList();
  if (!roots.length) throw new Error(t('idx.noDocs'));
  indexRunning = true;
  indexAbort = new AbortController();
  try {
    // Own embeddings server (llamafile mode) still stopped: start it automatically.
    const es = settings.embed;
    if (es.mode === 'spawn' && es.file && servers.embed.status !== 'running') {
      log('index', t('idx.embedStart'));
      send('servers-status', state().servers);
      try {
        await servers.embed.start({ file: es.file, port: es.port, args: es.args, embedding: true, gpu: es.gpu });
      } finally {
        send('servers-status', state().servers);
      }
    }
    const result = await indexFolders({
      roots,
      db: database,
      embedUrl: settings.embed.url,
      embedModel: settings.embed.model,
      ignore: settings.ignore,
      ocr: settings.ocr,
      signal: indexAbort.signal,
      onProgress: (p) => send('index-progress', p),
    });
    send('index-done', { result, auto });
    return result;
  } finally {
    indexRunning = false;
    indexAbort = null;
    if (indexPending) {
      indexPending = false;
      scheduleAutoIndex();
    }
  }
}

function scheduleAutoIndex() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    runIndex({ auto: true }).catch((e) => {
      log('index', t('idx.autoFailLog', { e: e.message }));
      send('index-error', { message: e.message, auto: true });
    });
  }, 4000);
}

function restartWatchers() {
  for (const w of watchers) {
    try {
      w.close();
    } catch {
      /* ignore */
    }
  }
  watchers = [];
  if (!settings.autoIndex) return;
  const ignored = makeIgnore(settings.ignore);
  for (const { dir, kind } of rootsList()) {
    try {
      const w = fs.watch(dir, { recursive: true }, (_ev, filename) => {
        if (!filename) return;
        const segs = String(filename).split(path.sep);
        if (segs.some((s) => SKIP_DIRS.has(s))) return;
        if (kind === 'brain' && ['memory.md', 'memoria.md'].includes(segs[segs.length - 1].toLowerCase())) return;
        if (ignored(path.join(dir, String(filename)), dir)) return;
        scheduleAutoIndex();
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch (e) {
      log('watch', t('idx.watchFail', { dir, e: e.message }));
    }
  }
}

// ---------------------------------------------------------------- window
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Llamafile Brain',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu?.();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

async function pickDir(title) {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : fs.realpathSync(r.filePaths[0]);
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  const extStatus = { chat: 'stopped', embed: 'stopped', rerank: 'stopped' };
  const state = () => ({
    settings,
    servers: Object.fromEntries(SERVERS.map((n) => [n, settings[n].mode === 'spawn' ? servers[n].status : extStatus[n]])),
    stats: fullStats(),
    defaultDbDir: path.join(userDir, 'brain'),
  });

  ipcMain.handle('settings:get', () => state());
  ipcMain.handle('settings:save', (_e, patch) => {
    applySettingsPatch(patch);
    return settings;
  });

  ipcMain.handle('files:pick', async (_e, kind) => {
    const r = await dialog.showOpenDialog(win, { title: t('dlg.pickLlamafile', { kind }), properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });

  // ---- folders: documents, brain notes, database
  ipcMain.handle('folders:add', async () => {
    const p = await pickDir(t('dlg.pickDocs'));
    if (p && !settings.folders.includes(p)) settings.folders.push(p);
    saveSettings();
    restartWatchers();
    return settings.folders;
  });
  ipcMain.handle('folders:remove', (_e, p) => {
    settings.folders = settings.folders.filter((f) => f !== p);
    saveSettings();
    purgeOutsideRoots();
    restartWatchers();
    return { folders: settings.folders, stats: fullStats() };
  });
  ipcMain.handle('brain:set', async () => {
    const p = await pickDir(t('dlg.pickBrain'));
    if (p) {
      settings.brainDir = p;
      saveSettings();
      lastMemKey = null;
      exportMemory();
      restartWatchers();
    }
    return { brainDir: settings.brainDir, stats: fullStats() };
  });
  ipcMain.handle('brain:clear', () => {
    settings.brainDir = '';
    saveSettings();
    purgeOutsideRoots();
    restartWatchers();
    return { brainDir: '', stats: fullStats() };
  });
  ipcMain.handle('db:set', async () => {
    const p = await pickDir(t('dlg.pickDb'));
    if (p) {
      settings.dbDir = p;
      saveSettings();
      openDb();
    }
    return { dbDir: settings.dbDir, stats: fullStats() };
  });
  ipcMain.handle('db:reset', () => {
    settings.dbDir = '';
    saveSettings();
    openDb();
    return { dbDir: '', stats: fullStats() };
  });

  // ---- servers
  ipcMain.handle('servers:start', async (_e, which) => {
    if (!SERVERS.includes(which)) throw new Error(t('main.badServer'));
    const s = settings[which];
    if (s.mode !== 'spawn') {
      // External server (Ollama etc.): "Start" really tests the URL + model and shows the result.
      extStatus[which] = 'starting';
      send('servers-status', state().servers);
      try {
        const r = await checkExternal(which, s.url, s.model);
        extStatus[which] = 'running';
        log(which, t('ext.ok', { url: s.url, model: s.model || 'local' }) + (r.dim ? ` (${r.dim}d)` : ''));
      } catch (e) {
        extStatus[which] = 'error';
        log(which, e.message);
        throw e;
      } finally {
        send('servers-status', state().servers);
      }
      return state().servers;
    }
    const clash = SERVERS.find((o) => o !== which && settings[o].mode === 'spawn' && settings[o].port === s.port);
    if (clash) throw new Error(t('main.samePort', { a: which, b: clash, port: s.port }));
    // Busy port: ask (modal) whether to switch to a random free one instead of just failing.
    if (!(await portFree(s.port))) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: [t('dlg.portChange'), t('dlg.cancel')],
        defaultId: 0,
        cancelId: 1,
        title: t('dlg.portTitle'),
        message: t('dlg.portMsg', { port: s.port }),
        detail: t('dlg.portDetail'),
      });
      if (response !== 0) throw new Error(t('srv.portBusy', { port: s.port }));
      const taken = new Set(SERVERS.map((o) => settings[o].port));
      let port = 0;
      for (let i = 0; i < 50 && !port; i++) {
        const c = 20000 + Math.floor(Math.random() * 40000);
        if (!taken.has(c) && (await portFree(c))) port = c;
      }
      if (!port) throw new Error(t('srv.portBusy', { port: s.port }));
      s.port = port;
      saveSettings();
      log(which, t('dlg.portChanged', { port }));
    }
    send('servers-status', state().servers);
    try {
      await servers[which].start({ file: s.file, port: s.port, args: s.args, embedding: which === 'embed', gpu: s.gpu });
    } finally {
      send('servers-status', state().servers);
    }
    return state().servers;
  });
  ipcMain.handle('servers:stop', (_e, which) => {
    if (!SERVERS.includes(which)) throw new Error(t('main.badServer'));
    servers[which].stop();
    extStatus[which] = 'stopped';
    return state().servers;
  });

  // ---- indexing
  ipcMain.handle('index:run', async () => {
    if (indexRunning) throw new Error(t('idx.running'));
    return runIndex({ auto: false });
  });
  ipcMain.handle('index:cancel', () => indexAbort?.abort());
  ipcMain.handle('index:clear', () => {
    getDb().clear();
    return fullStats();
  });
  ipcMain.handle('ocr:status', () => ocrStatus());


  // ---- optional dependencies (Setup tab)
  const APP_ROOT = path.resolve(__dirname, '..');
  const elevate = () => (process.platform === 'linux' ? (deps.has('pkexec') ? 'pkexec' : null) : 'sudo');
  const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

  function depsPlan() {
    const manager = deps.detectManager();
    const miss = new Set(deps.missingItems());
    const items = Object.keys(deps.PACKAGES).map((id) => ({
      id,
      label: deps.PACKAGES[id].label, // i18n key
      installed: !miss.has(id),
      command: manager ? deps.installCommand(id, manager, { root: isRoot(), elevate: 'pkexec' }) : null,
    }));
    const sb = deps.sandboxStatus(APP_ROOT);
    if (sb.applicable) {
      items.push({
        id: 'sandbox',
        label: 'dep.sandbox',
        installed: sb.ok,
        command: deps.sandboxCommand(APP_ROOT, { root: isRoot(), elevate: 'pkexec' }),
      });
    }
    return { platform: process.platform, manager, items };
  }
  function commandFor(id, manager) {
    const el = elevate();
    if (process.platform === 'linux' && !el && !isRoot()) {
      throw new Error(t('dep.noPkexec'));
    }
    if (id === 'sandbox') return deps.sandboxCommand(APP_ROOT, { root: isRoot(), elevate: el || 'sudo' });
    if (!manager) throw new Error(t('dep.noManager'));
    const cmd = deps.installCommand(id, manager, { root: isRoot(), elevate: el || 'sudo' });
    if (!cmd) throw new Error(t('dep.noPackage', { id, mgr: manager }));
    return cmd;
  }
  const runCommand = (cmd) =>
    new Promise((resolve) => {
      log('setup', `$ ${cmd.join(' ')}`);
      const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
      const full = cmd[0] === 'pkexec' && cmd[1] === 'apt-get' ? ['pkexec', 'env', 'DEBIAN_FRONTEND=noninteractive', ...cmd.slice(1)] : cmd;
      const p = spawn(full[0], full.slice(1), { env, shell: process.platform === 'win32', windowsHide: true });
      p.stdout.on('data', (d) => log('setup', d.toString()));
      p.stderr.on('data', (d) => log('setup', d.toString()));
      p.on('error', (e) => {
        log('setup', `error: ${e.message}`);
        resolve(false);
      });
      p.on('exit', (code) => resolve(code === 0));
    });
  let depsBusy = false;

  ipcMain.handle('deps:status', () => depsPlan());
  ipcMain.handle('deps:install', async (_e, ids) => {
    if (depsBusy) throw new Error(t('dep.busy'));
    const plan = depsPlan();
    const wanted = (Array.isArray(ids) ? ids : []).filter((id) => plan.items.some((i) => i.id === id && !i.installed));
    if (!wanted.length) return { ...plan, cancelled: false, results: [] };
    const cmds = wanted.map((id) => ({ id, cmd: commandFor(id, plan.manager) }));
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [t('dlg.install'), t('dlg.cancel')],
      defaultId: 1,
      cancelId: 1,
      title: t('dlg.installTitle'),
      message: t('dlg.installMsg'),
      detail: cmds.map(({ cmd }) => cmd.join(' ')).join('\n\n') +
        `\n\n${t('dlg.installDetail')}`,
    });
    if (response !== 0) return { ...depsPlan(), cancelled: true, results: [] };
    depsBusy = true;
    const results = [];
    try {
      for (const { id, cmd } of cmds) {
        send('deps-progress', { id, state: 'running' });
        const ok = await runCommand(cmd);
        results.push({ id, ok });
        send('deps-progress', { id, state: ok ? 'done' : 'failed' });
      }
    } finally {
      depsBusy = false;
    }
    return { ...depsPlan(), cancelled: false, results };
  });

  // ---- memory
  ipcMain.handle('memory:list', () => getDb().listMemories());
  ipcMain.handle('memory:add', (_e, text) => {
    getDb().addMemory(text);
    exportMemory();
    return getDb().listMemories();
  });
  ipcMain.handle('memory:delete', (_e, id) => {
    getDb().deleteMemory(Number(id));
    exportMemory();
    return getDb().listMemories();
  });
  ipcMain.handle('memory:clear', () => {
    getDb().clearMemories();
    exportMemory();
    return [];
  });

  // ---- evaluation
  ipcMain.handle('eval:run', async (_e, text) => {
    applySettingsPatch({ evalSet: text });
    const database = getDb();
    return runEval(
      text,
      (q) => retrieve({ question: q, db: database, settings, onWarn: (w) => log('rag', w) }),
      { onProgress: (p) => send('eval-progress', p) },
    );
  });

  // ---- chat
  ipcMain.handle('chat:ask', async (_e, { question, history }) => {
    if (typeof question !== 'string' || !question.trim()) throw new Error('Pergunta vazia');
    const qTokens = estimateTokens(question);
    if (qTokens > settings.maxInputTokens) {
      throw new Error(t('chat.tooLong', { n: qTokens, max: settings.maxInputTokens }));
    }
    const database = getDb();
    chatAbort?.abort();
    chatAbort = new AbortController();
    const hist = Array.isArray(history)
      ? history
          .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
          .map((m) => ({ role: m.role, content: m.content }))
      : [];
    try {
      const r = await ask({
        question,
        history: hist,
        db: database,
        settings,
        signal: chatAbort.signal,
        onSources: (s) => send('chat-sources', s),
        onDelta: (t) => send('chat-delta', t),
        onWarn: (w) => {
          log('rag', w);
          send('chat-warn', w);
        },
      });
      if (exportMemory()) send('memory-changed', database.listMemories());
      return r;
    } finally {
      chatAbort = null;
    }
  });
  ipcMain.handle('chat:cancel', () => chatAbort?.abort());

  ipcMain.handle('open:path', (_e, p) => {
    // Only reveal files inside the allowed folders.
    const real = typeof p === 'string' && fs.existsSync(p) ? fs.realpathSync(p) : null;
    if (real && rootsList().some((r) => real.startsWith(r.dir + path.sep))) shell.showItemInFolder(real);
  });
}

app.whenReady().then(() => {
  userDir = app.getPath('userData');
  settings = loadSettings();
  I18N.setLang(settings.language);
  openDb();
  registerIpc();
  createWindow();
  restartWatchers();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  for (const s of Object.values(servers)) s.stop();
  for (const w of watchers) {
    try {
      w.close();
    } catch {
      /* ignore */
    }
  }
  if (db) db.close();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
