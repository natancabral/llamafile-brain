'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
// ---------------------------------------------------------------- i18n
const tr = (key, params) => I18N.t(key, params);
/** Safe rich text: `code`, **bold**, *italic*, [text](https://url) — built with DOM nodes (no innerHTML). */
function richText(node, str) {
  node.textContent = '';
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(str))) {
    if (m.index > last) node.append(str.slice(last, m.index));
    const tok = m[0];
    if (tok[0] === '`') node.append(el('code', null, tok.slice(1, -1)));
    else if (tok.startsWith('**')) node.append(el('b', null, tok.slice(2, -2)));
    else if (tok[0] === '*') node.append(el('i', null, tok.slice(1, -1)));
    else {
      const [, label, url] = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
      if (/^https?:\/\//.test(url)) {
        const a = el('a', null, label);
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        node.append(a);
      } else node.append(label);
    }
    last = re.lastIndex;
  }
  if (last < str.length) node.append(str.slice(last));
}
function applyI18n(root = document) {
  const flag = document.getElementById('lang-flag');
  if (flag) flag.dataset.flag = I18N.getLang();
  root.querySelectorAll('[data-i18n]').forEach((n) => richText(n, tr(n.dataset.i18n)));
  root.querySelectorAll('[data-i18n-ph]').forEach((n) => (n.placeholder = tr(n.dataset.i18nPh)));
  document.documentElement.lang = I18N.getLang();
}

const history = [];
let busy = false;
let state = null;

const SERVER_DEFS = [
  { key: 'chat', title: 'srv.chat.title', hint: 'srv.chat.hint' },
  { key: 'embed', title: 'srv.embed.title', hint: 'srv.embed.hint' },
  { key: 'rerank', title: 'srv.rerank.title', hint: 'srv.rerank.hint' },
];

// ---------------------------------------------------------------- tabs
function selectTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
}
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));

// ---------------------------------------------------------------- settings <-> inputs (data-s="a.b.c")
const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
function setPath(obj, p, v) {
  const keys = p.split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k) => (o = o[k] ??= {}));
  o[keys.at(-1)] = v;
}
function readInput(e) {
  if (e.type === 'checkbox') return e.checked;
  if (e.type === 'number' || e.type === 'range') return Number(e.value);
  if (e.dataset.type === 'lines') return e.value.split('\n').map((s) => s.trim()).filter(Boolean);
  return e.value;
}
function writeInput(e, v) {
  if (e.type === 'checkbox') e.checked = !!v;
  else if (e.dataset.type === 'lines') e.value = (v || []).join('\n');
  else e.value = v ?? '';
}
function readPatch() {
  const patch = {};
  document.querySelectorAll('[data-s]').forEach((e) => setPath(patch, e.dataset.s, readInput(e)));
  return patch;
}
function fillInputs(settings) {
  document.querySelectorAll('[data-s]').forEach((e) => writeInput(e, getPath(settings, e.dataset.s)));
  updateVWeight();
  document.querySelectorAll('.srv').forEach((b) => toggleMode(b));
}
async function saveAll() {
  state.settings = await window.api.saveSettings(readPatch());
}
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-s]')) saveAll().catch((err) => addNote(tr('chat.saveErr', { e: err.message })));
});

function updateVWeight() {
  const v = Number($('vweight').value);
  $('vweight-val').textContent = tr('se.vweight', { v: Math.round(v * 100), k: Math.round((1 - v) * 100) });
}
$('vweight').addEventListener('input', updateVWeight);

// ---------------------------------------------------------------- servers
function toggleMode(block) {
  const ext = block.querySelector('[data-k="mode"]').value === 'external';
  block.querySelector('.spawn').classList.toggle('hidden', ext);
  block.querySelector('.external').classList.toggle('hidden', !ext);
}

function buildServers() {
  const tpl = $('srv-tpl');
  const host = $('servers');
  host.textContent = '';
  for (const def of SERVER_DEFS) {
    const block = tpl.content.firstElementChild.cloneNode(true);
    block.dataset.which = def.key;
    block.querySelector('.srv-title').dataset.i18n = def.title;
    block.querySelector('.srv-hint').dataset.i18n = def.hint;
    applyI18n(block);
    block.querySelectorAll('[data-k]').forEach((inp) => (inp.dataset.s = `${def.key}.${inp.dataset.k}`));
    block.querySelector('[data-k="mode"]').addEventListener('change', () => toggleMode(block));
    block.querySelector('.pick').onclick = async () => {
      const f = await window.api.pickFile(def.key);
      if (f) {
        const inp = block.querySelector('[data-k="file"]');
        inp.value = f;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };
    block.querySelector('.start').onclick = async () => {
      if (block.querySelector('.start').disabled) return;
      setStatus({ ...state.servers, [def.key]: 'starting' }); // feedback imediato: um clique basta
      try {
        await saveAll();
        setStatus(await window.api.startServer(def.key));
      } catch (e) {
        addNote(tr('srv.startFail', { title: tr(def.title), e: e.message }));
        setStatus((await window.api.getState()).servers);
      }
      // the main process may have switched the port (busy-port prompt): show the saved value
      state = await window.api.getState();
      fillInputs(state.settings);
    };
    block.querySelector('.stop').onclick = async () => setStatus(await window.api.stopServer(def.key));
    host.append(block);
  }
}
// While a server is starting: spinner (CSS) + elapsed seconds, so loading a big model never looks frozen.
const startTimers = new WeakMap();
function trackStarting(block, s) {
  const badge = block.querySelector('.badge');
  const t = startTimers.get(block);
  if (s !== 'starting') {
    if (t) clearInterval(t.id);
    startTimers.delete(block);
    return;
  }
  if (t) return;
  const t0 = Date.now();
  const tick = () => {
    if (badge.classList.contains('starting')) badge.textContent = `${tr('status.starting')} ${Math.floor((Date.now() - t0) / 1000)}s`;
  };
  startTimers.set(block, { id: setInterval(tick, 1000) });
}
function setStatus(st) {
  state.servers = st;
  document.querySelectorAll('.srv').forEach((b) => {
    const s = st[b.dataset.which];
    const badge = b.querySelector('.badge');
    badge.textContent = ['stopped', 'starting', 'running', 'error'].includes(s) ? tr(`status.${s}`) : s;
    badge.className = `badge ${s}`;
    trackStarting(b, s);
    const start = b.querySelector('.start');
    if (start) start.disabled = s === 'starting' || s === 'running'; // already starting/running: no need to click again
  });
}
window.api.onServersStatus(setStatus);

// ---------------------------------------------------------------- knowledge
let lastStats = null;
function showStats(stats) {
  if (!stats) return;
  lastStats = stats;
  $('db-path').value = stats.dbFile || '';
  $('stats').textContent = stats.error
    ? tr('kn.dbError', { e: stats.error })
    : tr('kn.stats', { files: stats.files, chunks: stats.chunks, memories: stats.memories });
}
function renderFolders(list) {
  const ul = $('folders');
  ul.textContent = '';
  list.forEach((f) => {
    const li = el('li');
    li.append(el('span', null, f));
    const b = el('button', null, '×');
    b.title = tr('kn.removeFolder');
    b.onclick = async () => {
      const r = await window.api.removeFolder(f);
      renderFolders(r.folders);
      showStats(r.stats);
    };
    li.append(b);
    ul.append(li);
  });
}
$('add-folder').onclick = async () => renderFolders(await window.api.addFolder());
$('brain-pick').onclick = async () => {
  const r = await window.api.setBrainDir();
  $('brain-path').value = r.brainDir;
  showStats(r.stats);
};
$('brain-clear').onclick = async () => {
  const r = await window.api.clearBrainDir();
  $('brain-path').value = '';
  showStats(r.stats);
};
$('db-pick').onclick = async () => {
  const r = await window.api.setDbDir();
  showStats(r.stats);
  refreshMemories();
};
$('db-reset').onclick = async () => {
  const r = await window.api.resetDbDir();
  showStats(r.stats);
  refreshMemories();
};
$('ocr-check').onclick = async () => {
  const s = await window.api.ocrStatus();
  $('ocr-status').textContent = `tesseract: ${s.tesseract ? tr('su.ocr.ok') : tr('su.ocr.missing')} · pdftoppm: ${s.pdftoppm ? tr('su.ocr.ok') : tr('su.ocr.missing')}`;
  refreshDeps();
};

$('index-cancel').onclick = () => window.api.cancelIndex();
$('index-clear').onclick = async () => {
  const r = await window.api.clearIndex();
  showStats(r);
  $('index-status').textContent = tr('idx.cleared');
};
$('index-run').onclick = async () => {
  try {
    await saveAll();
    $('index-run').disabled = true;
    await window.api.runIndex(); // result is shown by the index-done event
  } catch (e) {
    $('index-status').textContent = tr('idx.failed', { e: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
  } finally {
    $('index-run').disabled = false;
  }
};
window.api.onIndexProgress((p) => {
  $('index-status').textContent =
    p.phase === 'done' ? tr('idx.done') : tr('idx.progress', { done: p.done, total: p.total, file: p.file ? p.file.split(/[\\/]/).pop() : '' });
});
window.api.onIndexDone(({ result: r, auto }) => {
  showStats(r);
  const lines = [auto ? tr('idx.doneAuto') : tr('idx.done'), tr('idx.counts', { indexed: r.indexed, unchanged: r.unchanged })];
  const sk = Object.entries(r.skipped || {}).map(([ext, n]) => `${n}× ${ext}`);
  if (sk.length) lines.push(tr('idx.skippedTypes', { list: sk.join(', ') }));
  if (r.failed?.length) lines.push(tr('idx.unreadable', { list: `${r.failed.slice(0, 8).join(', ')}${r.failed.length > 8 ? '…' : ''}` }));
  (r.warnings || []).forEach((w) => lines.push(`⚠ ${w}`));
  $('index-status').textContent = lines.join('\n');
});
window.api.onIndexError(({ message }) => {
  $('index-status').textContent = tr('idx.autoFail', { e: message });
});

// ---------------------------------------------------------------- memory
function renderMemories(list) {
  const ul = $('memlist');
  ul.textContent = '';
  if (!list.length) {
    ul.append(el('li', 'muted', tr('mem.none')));
    return;
  }
  list.forEach((m) => {
    const li = el('li');
    const span = el('span');
    span.append(el('span', 'id', `#${m.id}`), document.createTextNode(m.text));
    const b = el('button', null, '×');
    b.title = tr('mem.forget');
    b.onclick = async () => renderMemories(await window.api.deleteMemory(m.id));
    li.append(span, b);
    ul.append(li);
  });
}
async function refreshMemories() {
  try {
    renderMemories(await window.api.listMemories());
  } catch (e) {
    renderMemories([]);
  }
}
$('mem-add').onclick = async () => {
  const t = $('mem-input').value.trim();
  if (!t) return;
  renderMemories(await window.api.addMemory(t));
  $('mem-input').value = '';
};
$('mem-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('mem-add').click();
});
$('mem-clear').onclick = async () => {
  if (confirm(tr('mem.clearConfirm'))) renderMemories(await window.api.clearMemories());
};
window.api.onMemoryChanged(renderMemories);

// ---------------------------------------------------------------- evaluation
window.api.onEvalProgress((p) => {
  $('eval-progress').textContent = tr('ev.testing', { n: p.done + 1, total: p.total });
});
$('eval-run').onclick = async () => {
  const out = $('eval-out');
  out.textContent = '';
  $('eval-run').disabled = true;
  try {
    const r = await window.api.runEval($('eval-set').value);
    $('eval-progress').textContent = '';
    if (!r.total) {
      out.append(el('p', 'muted', tr('ev.none')));
      return;
    }
    const hits = r.results.filter((x) => x.rank).length;
    out.append(el('p', null, tr('ev.result', { hits, total: r.total, pct: Math.round(r.hitRate * 100), mrr: r.mrr.toFixed(2) })));
    const table = el('table');
    const head = el('tr');
    ['ev.col.q', 'ev.col.exp', 'ev.col.pos'].forEach((h) => head.append(el('th', null, tr(h))));
    table.append(head);
    r.results.forEach((x) => {
      const row = el('tr');
      row.append(el('td', null, x.question), el('td', null, x.expected));
      row.append(el('td', x.rank ? 'rank-ok' : 'rank-no', x.error ? tr('ev.err', { e: x.error }) : x.rank ? `✓ #${x.rank}` : tr('ev.miss')));
      table.append(row);
    });
    out.append(table);
  } catch (e) {
    out.append(el('p', 'muted', tr('ev.failed', { e: e.message })));
  } finally {
    $('eval-run').disabled = false;
  }
};

// ---------------------------------------------------------------- setup (optional dependencies)
let depsBusy = false;
function renderDeps(plan) {
  const list = $('deps-list');
  list.replaceChildren();
  const missing = plan.items.filter((i) => !i.installed);
  for (const it of plan.items) {
    const row = el('div', 'dep-row');
    row.append(el('span', 'dep-label', tr(it.label)), el('span', it.installed ? 'badge ok' : 'badge', it.installed ? tr('su.deps.installed') : tr('su.deps.missing')));
    if (!it.installed) {
      const b = el('button', null, tr('su.deps.install'));
      b.dataset.dep = it.id;
      b.disabled = depsBusy;
      b.onclick = () => installDeps([it.id]);
      row.append(b);
    }
    list.append(row);
  }
  $('deps-install-all').disabled = depsBusy || !missing.length;
  $('deps-status').textContent = missing.length
    ? tr('su.deps.count', { n: missing.length, mgr: plan.manager ? tr('su.deps.mgr', { m: plan.manager }) : tr('su.deps.noMgr') })
    : tr('su.deps.allOk');
  state.lastPlan = plan;
}
async function refreshDeps() {
  try {
    renderDeps(await window.api.getDeps());
  } catch (e) {
    $('deps-status').textContent = tr('su.deps.failed', { e: e.message });
  }
}
async function installDeps(ids) {
  depsBusy = true;
  $('deps-status').textContent = tr('su.deps.waiting');
  document.querySelectorAll('#deps-list button, #deps-install-all').forEach((b) => (b.disabled = true));
  try {
    const r = await window.api.installDeps(ids);
    depsBusy = false;
    renderDeps(r);
    if (r.cancelled) $('deps-status').textContent = tr('su.deps.cancelled');
    else if (r.results.some((x) => !x.ok)) $('deps-status').textContent = tr('su.deps.someFailed');
  } catch (e) {
    depsBusy = false;
    await refreshDeps();
    $('deps-status').textContent = tr('su.deps.failed', { e: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
  }
}
$('deps-install-all').onclick = async () => {
  const plan = await window.api.getDeps();
  installDeps(plan.items.filter((i) => !i.installed).map((i) => i.id));
};
$('deps-refresh').onclick = refreshDeps;
window.api.onDepsProgress(({ id, state }) => {
  const b = document.querySelector(`#deps-list button[data-dep="${id}"]`);
  if (b) b.textContent = state === 'running' ? tr('su.deps.installing') : state === 'done' ? tr('su.deps.done') : tr('su.deps.failedBtn');
  if (state === 'running') $('deps-status').textContent = tr('su.deps.progress', { id });
});
refreshDeps();

// ---------------------------------------------------------------- logs
window.api.onLog(({ source, text }) => {
  const pre = $('logs');
  pre.textContent += `[${source}] ${text}${text.endsWith('\n') ? '' : '\n'}`;
  if (pre.textContent.length > 60000) pre.textContent = pre.textContent.slice(-40000);
  pre.scrollTop = pre.scrollHeight;
});

// ---------------------------------------------------------------- chat
const messages = $('messages');
const scroll = () => (messages.scrollTop = messages.scrollHeight);

function addNote(text) {
  const d = el('div', 'msg error');
  d.textContent = text;
  messages.append(d);
  scroll();
}

/** current assistant message: { d, body, th, raw, queued, idle } */
let cur = null;

function startAssistant() {
  const d = el('div', 'msg assistant');
  const body = el('div', 'body');
  const th = el('div', 'thinking');
  th.append(el('span', 'think-text', tr('chat.thinking')), el('span', 'dots'));
  d.append(body, th);
  messages.append(d);
  scroll();
  return { d, body, th, raw: '', queued: false, idle: null };
}
// "Pensando..." is shown while we wait, and again whenever the stream pauses (e.g. between file summaries).
function armIdle() {
  clearTimeout(cur.idle);
  cur.idle = setTimeout(() => cur?.th.classList.remove('hidden'), 1200);
}
function scheduleRender() {
  if (!cur || cur.queued) return;
  cur.queued = true;
  requestAnimationFrame(() => {
    if (!cur) return;
    cur.queued = false;
    renderMarkdown(cur.body, cur.raw);
    scroll();
  });
}
window.api.onDelta((t) => {
  if (!cur) return;
  cur.th.classList.add('hidden');
  cur.raw += t;
  scheduleRender();
  armIdle();
});
window.api.onWarn((w) => {
  if (cur) cur.d.append(el('div', 'warn', `⚠ ${w}`));
});

function addSources(div, sources) {
  if (!sources.length) return;
  const box = el('div', 'sources');
  sources.forEach((s, i) => {
    const chip = el('span', 'chip', `[${i + 1}] ${s.path.split(/[\\/]/).pop()}:${s.start}-${s.end}`);
    chip.title = s.path;
    chip.onclick = () => window.api.revealFile(s.path);
    box.append(chip);
  });
  div.append(box);
}

function setBusy(b) {
  busy = b;
  $('send').classList.toggle('hidden', b);
  $('stop').classList.toggle('hidden', !b);
}

// Question token counter (estimate: ~3.5 characters per token); sending is blocked above the limit.
const estimateTokens = (t) => Math.ceil(String(t || '').length / 3.5);
function updateTokenCount() {
  const used = estimateTokens($('input').value);
  const max = state.settings?.maxInputTokens || 1000;
  const over = used > max;
  const box = $('token-count');
  box.textContent = used ? tr('chat.tokens', { used, max }) + (over ? tr('chat.tokensOver') : '') : '';
  box.classList.toggle('over', over);
  $('send').disabled = over;
  return over;
}
$('input').addEventListener('input', updateTokenCount);
document.addEventListener('change', (e) => e.target.matches?.('[data-s="maxInputTokens"]') && setTimeout(updateTokenCount, 0));

$('form').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('input').value.trim();
  if (!q || busy || updateTokenCount()) return;
  $('input').value = '';
  updateTokenCount();
  const u = el('div', 'msg user');
  u.textContent = q; // user text stays plain text
  messages.append(u);
  cur = startAssistant();
  armIdle();
  setBusy(true);
  try {
    const { answer, sources } = await window.api.ask(q, history);
    clearTimeout(cur.idle);
    cur.th.remove();
    renderMarkdown(cur.body, answer || tr('chat.noAnswer'));
    addSources(cur.d, sources || []);
    history.push({ role: 'user', content: q }, { role: 'assistant', content: answer });
  } catch (err) {
    clearTimeout(cur.idle);
    cur.th.remove();
    const msg = String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    if (/abort/i.test(msg)) {
      cur.d.append(el('div', 'muted', tr('chat.interrupted')));
    } else {
      cur.d.classList.add('error');
      cur.raw += `\n\n${tr('chat.error', { e: msg })}`;
      renderMarkdown(cur.body, cur.raw);
    }
  } finally {
    cur = null;
    setBusy(false);
    scroll();
  }
};
$('stop').onclick = () => window.api.cancelChat();
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('form').requestSubmit();
  }
});

// ---------------------------------------------------------------- init
async function init() {
  state = await window.api.getState();
  I18N.setLang(state.settings.language);
  $('lang').value = I18N.getLang();
  applyI18n();
  buildServers();
  fillInputs(state.settings);
  $('brain-path').value = state.settings.brainDir || '';
  $('eval-set').value = state.settings.evalSet || '';
  renderFolders(state.settings.folders);
  setStatus(state.servers);
  showStats(state.stats);
  refreshMemories();
}
// Language selector: saves the setting (main process switches its own language too) and re-renders everything.
function relocalize() {
  applyI18n();
  setStatus(state.servers);
  if (lastStats) showStats(lastStats);
  updateVWeight();
  updateTokenCount();
  refreshMemories();
  refreshDeps();
}
$('lang').addEventListener('change', async () => {
  const lang = I18N.setLang($('lang').value);
  state.settings = await window.api.saveSettings({ language: lang });
  relocalize();
});
$('eval-set').addEventListener('change', () => window.api.saveSettings({ evalSet: $('eval-set').value }));
init();
