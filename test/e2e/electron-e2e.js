'use strict';

/**
 * End-to-end check of the REAL Electron app (main + preload + renderer) with mock model servers.
 * Run:  xvfb-run -a npx electron test/e2e/electron-e2e.js --no-sandbox     (Linux, headless)
 *       npx electron test/e2e/electron-e2e.js                              (with a display)
 * Writes screenshots to $E2E_OUT (default /tmp/lfb-e2e).
 */
const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lfb-e2e-'));
const out = process.env.E2E_OUT || '/tmp/lfb-e2e';
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(tmp, 'userData'));

const { startMock } = require('../helpers');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const docs = path.join(tmp, 'Documents');
const brain = path.join(tmp, 'brain');
const dbdir = path.join(tmp, 'sqlite');
for (const d of [docs, brain, dbdir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(docs, 'billing.md'), '# Billing\nWe now also accept credit cards.\n');
fs.writeFileSync(path.join(docs, 'auth.js'), '// login\nfunction login(user) { return jwtSign(user); }\n');
fs.mkdirSync(path.join(docs, 'private'));
fs.writeFileSync(path.join(docs, 'private', 'exam.md'), 'health secret');
fs.writeFileSync(path.join(brain, 'nota.md'), '# Decision\nWe use pnpm in every project.\n');

const queue = [docs, brain, dbdir]; // answers for the folder pickers, in order
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });

let msgBoxAnswer = 1; // 1 = "Cancel" (install prompt); the port test sets 0 = "Use a random port"
const msgBoxCalls = [];
dialog.showMessageBox = async (_w, o) => { msgBoxCalls.push(o); return { response: msgBoxAnswer }; };

const results = [];
const consoleErrors = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`);
};

require('../../src/main.js');

app.whenReady().then(async () => {
  const mock = await startMock({
    chatDelay: 1500,
    chatReply: '## Summary\n\nThe system accepts **credit cards** [1].\n\n- Pix\n- Bank slip\n\n```js\nconst ok = true;\n```\n\n| Method | Accepted |\n|---|:-:|\n| Card | yes |\n',
  });
  let win;
  for (let i = 0; i < 50 && !(win = BrowserWindow.getAllWindows()[0]); i++) await sleep(100);
  win.webContents.on('console-message', (...a) => {
    const e = a[0] && a[0].message !== undefined ? a[0] : { level: a[1], message: a[2] };
    if (e.level === 'error' || e.level === 3) consoleErrors.push(e.message);
  });
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await sleep(500);
  win.setSize(1280, 820);
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());

  try {
    // ---- boot
    check('renderer booted (3 server blocks)', (await run("document.querySelectorAll('.srv').length")) === 3);
    check('preload bridge exposed', (await run("typeof window.api.ask")) === 'function');

    // ---- configure: external mock servers, ignore list, folders pickers
    await run(`api.saveSettings({ chat: { mode: 'external', url: ${JSON.stringify(mock.url)}, model: 'local' }, embed: { mode: 'external', url: ${JSON.stringify(mock.url)}, model: 'local' }, ignore: ['private'] })`);
    await run('api.addFolder()');
    await run('api.setBrainDir()');
    await run('api.setDbDir()');
    const st0 = await run('api.getState()');
    check('document folder, brain folder and sqlite folder chosen', st0.settings.folders[0] === docs && st0.settings.brainDir === brain && st0.settings.dbDir === dbdir);
    check('SQLite file created in the chosen folder', fs.existsSync(path.join(dbdir, 'brain.sqlite')));

    // ---- index (manual)
    const idx = await run('api.runIndex()');
    check('indexed docs + brain notes, ignore list respected', idx.files === 3 && idx.failed.length === 0, JSON.stringify(idx));
    const st1 = await run('api.getState()');
    check('stats reflect the index', st1.stats.files === 3 && st1.stats.chunks >= 3);

    // ---- memory via chat command + export to brain/memory.md
    const mem = await run("api.ask('remember that my name is Natan', [])");
    check('memory command answered by code', /Saved/.test(mem.answer));
    await sleep(200);
    const memFile = path.join(brain, 'memory.md');
    check('memory.md exported into the brain folder', fs.existsSync(memFile) && /my name is Natan/.test(fs.readFileSync(memFile, 'utf8')));
    check('memory visible in the panel API', (await run('api.listMemories()')).length === 1);

    // ---- real UI flow: "Thinking…" while waiting, then Markdown
    win.webContents.reload(); // as if the user reopened the app: the panel reads the saved settings
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await sleep(500);
    await run("document.querySelector('#tabs button[data-tab=\"knowledge\"]').click()");
    await sleep(200);
    await shot('1-knowledge.png');
    check('settings survive a reload (folders, brain and sqlite shown in the panel)', (await run("document.getElementById('brain-path').value")) === brain);
    await run("document.querySelector('#tabs button[data-tab=\"servers\"]').click()");
    await run("(() => { const i = document.getElementById('input'); i.value = 'do we accept credit cards?'; document.getElementById('form').requestSubmit(); })()");
    await sleep(700);
    const thinking = await run("(() => { const t = document.querySelector('.msg.assistant .thinking'); return t ? { visible: !t.classList.contains('hidden'), text: t.textContent } : null; })()");
    check('"Thinking" visible while waiting', thinking && thinking.visible && /Thinking/.test(thinking.text), JSON.stringify(thinking));
    await shot('2-thinking.png');
    await sleep(2500);
    const rendered = await run(`(() => { const m = document.querySelector('.msg.assistant'); return { h: m.querySelectorAll('h3').length, strong: m.querySelectorAll('strong').length, li: m.querySelectorAll('li').length, code: m.querySelectorAll('.codeblock').length, th: m.querySelectorAll('th').length, chips: m.querySelectorAll('.chip').length, thinking: !!m.querySelector('.thinking') }; })()`);
    check('answer rendered as Markdown (heading, bold, list, code block, table)', rendered.h === 1 && rendered.strong === 1 && rendered.li === 2 && rendered.code === 1 && rendered.th === 2, JSON.stringify(rendered));
    check('source chip shown and "Thinking" removed', rendered.chips === 1 && !rendered.thinking, JSON.stringify(rendered));
    await shot('3-answer.png');

    // ---- auto reindex when a file changes
    fs.writeFileSync(path.join(docs, 'new.md'), '# New\nFile created after indexing.\n');
    let files = 0;
    for (let i = 0; i < 20 && files < 4; i++) {
      await sleep(1000);
      files = (await run('api.getState()')).stats.files;
    }
    check('auto reindex picked up the new file (watcher)', files === 4, `files=${files}`);

    // ---- eval set through the real pipeline
    const ev = await run(`api.runEval('do we accept cards? => billing\\ndo we use pnpm? => nota')`);
    check('evaluation run returns hit rate', ev.total === 2 && ev.hitRate === 1, JSON.stringify(ev));

    await run("document.querySelector('#tabs button[data-tab=\"memory\"]').click()");
    await sleep(100);
    await shot('4-memory.png');

    // ---- Setup tab: status real e o pedido de confirmação (cancelado, nada é instalado)
    const dp = await run('api.getDeps()');
    check('deps status lists tesseract, poppler, libreoffice', ['tesseract', 'poppler', 'libreoffice'].every((id) => dp.items.some((i) => i.id === id)), JSON.stringify(dp.items.map((i) => i.id)));
    const miss = dp.items.find((i) => !i.installed);
    if (miss) {
      const inst = await run(`api.installDeps(['${miss.id}'])`);
      check('installing only runs after confirmation (cancel installs nothing)', inst.cancelled === true && inst.results.length === 0);
    }
    await run("document.querySelector('#tabs button[data-tab=\"setup\"]').click()");
    await sleep(300);
    await shot('5-setup.png');
    // ---- external server: Start tests the URL/model and reports running / error
    const stExt = await run(`api.startServer('embed')`);
    check('external embeddings: Start reports running', stExt.embed === 'running', JSON.stringify(stExt));
    await run(`api.saveSettings({ embed: { url: 'http://127.0.0.1:1' } })`);
    const extErr = await run(`api.startServer('embed').then(() => 'ok', (e) => e.message)`);
    check('external embeddings: wrong URL gives a clear error and status error', /Could not connect/.test(extErr) && (await run('api.getState()')).servers.embed === 'error', extErr);
    await run(`api.saveSettings({ embed: { url: ${JSON.stringify(mock.url)} } })`);

    // ---- busy port: the app asks, and on "yes" switches to a random free port
    const net = require('node:net');
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const busy = blocker.address().port;
    await run(`api.saveSettings({ chat: { mode: 'spawn', file: ${JSON.stringify(path.join(__dirname, '..', '..', 'package.json'))}, port: ${busy}, args: '' } })`);
    msgBoxCalls.length = 0;
    msgBoxAnswer = 1;
    const declined = await run(`api.startServer('chat').then(() => 'ok', (e) => e.message)`);
    check('busy port: prompt shown; declining keeps the error and the port', msgBoxCalls.length === 1 && /already in use/.test(declined) && (await run('api.getState()')).settings.chat.port === busy, declined);
    msgBoxAnswer = 0;
    await run(`api.startServer('chat').then(() => 'ok', (e) => e.message)`);
    const newPort = (await run('api.getState()')).settings.chat.port;
    check('busy port: accepting switches to a different free port (saved)', newPort !== busy && newPort >= 20000, String(newPort));
    msgBoxAnswer = 1;
    blocker.close();
    await run("api.saveSettings({ chat: { mode: 'external' } })");

    // ---- language selector: switch to Portuguese, then Spanish; the choice is persisted by the main process
    for (const [lang, tab, mem] of [['pt', 'Servidores', '#1'], ['es', 'Servidores', '#1']]) {
      await run(`(() => { const s = document.getElementById('lang'); s.value = '${lang}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(400);
      const label = await run("document.querySelector('#tabs button[data-tab=\"servers\"]').textContent");
      check(`language ${lang}: tabs re-translated`, label === tab, label);
    }
    const saved = await run('api.getState()');
    check('language persisted in settings', saved.settings.language === 'es', saved.settings.language);
    await run("document.querySelector('#tabs button[data-tab=\"servers\"]').click()");
    await sleep(200);
    const askEs = await run("api.ask('recuerda que me gusta el café', [])");
    check('memory command answered in the selected language (es)', /Guardado/.test(askEs.answer), askEs.answer);
    await shot('6-spanish.png');
    await run(`(() => { const s = document.getElementById('lang'); s.value = 'en'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(300);
    check('no console errors in the renderer', consoleErrors.length === 0, consoleErrors.join(' | '));
  } catch (e) {
    check(`unexpected error: ${e.message}`, false);
  }

  mock.server.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${out}`);
  app.exit(failed ? 1 : 0);
});
