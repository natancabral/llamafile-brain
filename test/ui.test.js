'use strict';

// Smoke test of the real renderer (index.html + markdown.js + renderer.js) in jsdom with a stubbed window.api.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  /* optional dev-only dependency */
}
const root = path.join(__dirname, '..', 'src', 'renderer');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('every element id used by renderer.js exists in index.html', () => {
  const html = read('index.html');
  const js = read('renderer.js');
  const used = [...new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))];
  const missing = used.filter((id) => !new RegExp(`id="${id}"`).test(html));
  assert.deepStrictEqual(missing, []);
});

function boot(language = 'en') {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const handlers = {};
  const calls = [];
  const on = (name) => (cb) => { handlers[name] = cb; };
  const settings = {
    chat: { mode: 'spawn', file: '', port: 8080, args: '-c 8192', url: 'http://127.0.0.1:8080', model: 'local' },
    embed: { mode: 'external', file: '', port: 8081, args: '', url: 'http://127.0.0.1:11434', model: 'embeddinggemma' },
    rerank: { enabled: false, candidates: 20, mode: 'spawn', file: '', port: 8082, args: '', url: '', model: 'local' },
    folders: ['/home/u/Documents'], brainDir: '/home/u/brain', ignore: ['prontuario', '*.zip'],
    ocr: { enabled: true, lang: 'por+eng', maxPages: 30 }, autoIndex: true, useFiles: true, maxInputTokens: 20, topK: 6,
    contextChars: 6000, historyTurns: 3, temperature: 0.2, summaryMaxFiles: 40,
    hybrid: { vectorWeight: 0.6 }, memory: { enabled: true, maxChars: 1500 }, profile: 'Prefiro respostas curtas.', evalSet: '', language,
  };
  let resolveAsk;
  let resolveStart;
  window.api = {
    getState: async () => ({ settings, servers: { chat: 'stopped', embed: 'running', rerank: 'stopped' }, stats: { files: 3, chunks: 9, memories: 1, dbFile: '/x/brain.sqlite' } }),
    saveSettings: async (p) => { calls.push(['save', p]); return settings; },
    listMemories: async () => [{ id: 1, text: 'meu nome é Natan' }],
    deleteMemory: async () => [], addMemory: async () => [], clearMemories: async () => [],
    ask: (q) => { calls.push(['ask', q]); return new Promise((r) => (resolveAsk = r)); },
    cancelChat: async () => {}, revealFile: async () => {},
    ocrStatus: async () => ({ tesseract: true, pdftoppm: false }),
    startServer: (w) => { calls.push(['start', w]); return new Promise((r) => (resolveStart = () => r({ chat: 'running', embed: 'running', rerank: 'stopped' }))); },
    getDeps: async () => ({ platform: 'linux', manager: 'apt-get', items: [
      { id: 'tesseract', label: 'dep.tesseract', installed: false, command: ['pkexec', 'apt-get', 'install', '-y', 'tesseract-ocr'] },
      { id: 'poppler', label: 'dep.poppler', installed: true, command: null },
    ] }),
    installDeps: async (ids) => { calls.push(['install', ids]); return { platform: 'linux', manager: 'apt-get', cancelled: true, results: [], items: [{ id: 'tesseract', label: 'dep.tesseract', installed: false }] }; },
    ...Object.fromEntries(['onLog', 'onIndexProgress', 'onIndexDone', 'onIndexError', 'onEvalProgress', 'onDelta', 'onSources', 'onWarn', 'onMemoryChanged', 'onServersStatus', 'onDepsProgress'].map((n) => [n, on(n.replace(/^on/, '').replace(/^./, (c) => c.toLowerCase()))])),
  };
  window.confirm = () => true;
  window.eval(fs.readFileSync(path.join(root, '..', 'shared', 'i18n.js'), 'utf8'));
  window.eval(read('markdown.js'));
  window.eval(read('renderer.js'));
  return { window, handlers, calls, finishAsk: (v) => resolveAsk(v), finishStart: () => resolveStart() };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('renderer boots: three server blocks, settings filled, tabs switch', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { window } = boot();
  await tick();
  const d = window.document;
  assert.strictEqual(d.querySelectorAll('.srv').length, 3);
  const help = d.getElementById('models-help');
  const link = help.querySelector('a');
  assert.strictEqual(link.href, 'https://huggingface.co/mozilla-ai/llamafile_0.10');
  assert.strictEqual(link.target, '_blank');
  assert.match(help.textContent, /llamafile column/);
  assert.match(help.textContent, /Qwen.*Ministral.*Gemma/s);
  assert.strictEqual(d.querySelector('.srv[data-which="embed"] .badge').textContent, 'running');
  assert.strictEqual(d.querySelector('.srv[data-which="embed"] [data-k="model"]').value, 'embeddinggemma');
  assert.ok(!d.querySelector('.srv[data-which="embed"] .external').classList.contains('hidden'), 'external mode shows the URL field');
  assert.ok(d.querySelector('.srv[data-which="embed"] .spawn').classList.contains('hidden'));
  assert.strictEqual(d.getElementById('brain-path').value, '/home/u/brain');
  assert.strictEqual(d.getElementById('db-path').value, '/x/brain.sqlite');
  assert.strictEqual(d.querySelector('[data-s="ignore"]').value, 'prontuario\n*.zip');
  assert.strictEqual(d.querySelector('[data-s="ocr.enabled"]').checked, true);
  assert.strictEqual(d.querySelector('[data-s="topK"]').value, '6');
  assert.match(d.getElementById('stats').textContent, /3 files · 9 chunks · 1 memories/);
  assert.match(d.getElementById('memlist').textContent, /#1.*meu nome é Natan/);
  assert.match(d.getElementById('vweight-val').textContent, /Vectors 60%/);

  d.querySelector('#tabs button[data-tab="memory"]').click();
  assert.ok(!d.querySelector('[data-panel="memory"]').classList.contains('hidden'));
  assert.ok(d.querySelector('[data-panel="servers"]').classList.contains('hidden'));
});

test('chat: animated "Thinking…" while waiting, then streamed Markdown, sources, history', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { window, handlers, calls, finishAsk } = boot();
  await tick();
  const d = window.document;
  d.getElementById('input').value = 'resuma o contrato';
  d.getElementById('form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
  await tick();

  const msg = d.querySelector('.msg.assistant');
  const thinking = msg.querySelector('.thinking');
  assert.ok(thinking && !thinking.classList.contains('hidden'), '"Thinking" is visible while waiting');
  assert.strictEqual(thinking.querySelector('.think-text').textContent, 'Thinking');
  assert.ok(thinking.querySelector('.dots'), 'animated dots element present');
  assert.deepStrictEqual(calls.at(-1), ['ask', 'resuma o contrato']);
  assert.strictEqual(d.querySelector('.msg.user').textContent, 'resuma o contrato');
  assert.ok(!d.getElementById('stop').classList.contains('hidden'), 'stop button while busy');

  handlers.delta('## Resumo\n\nO prazo é de **12 meses**.\n');
  await tick(60);
  assert.ok(thinking.classList.contains('hidden'), 'hidden as soon as text arrives');
  assert.strictEqual(msg.querySelectorAll('h3').length, 1, '"## x" renders as chat-sized h3');
  assert.strictEqual(msg.querySelectorAll('strong').length, 1);

  await tick(1400); // stream paused (e.g. between file summaries) -> "Thinking" comes back
  assert.ok(!thinking.classList.contains('hidden'), 'reappears when the stream goes quiet');

  handlers.delta('- a\n- b');
  finishAsk({ answer: '## Resumo\n\nO prazo é de **12 meses**.\n- a\n- b', sources: [{ path: '/home/u/Documents/contrato.md', start: 1, end: 4 }] });
  await tick(60);
  assert.strictEqual(msg.querySelector('.thinking'), null, 'indicator removed when done');
  assert.strictEqual(msg.querySelectorAll('li').length, 2);
  assert.strictEqual(msg.querySelectorAll('.chip').length, 1);
  assert.match(msg.querySelector('.chip').textContent, /\[1\] contrato\.md:1-4/);
  assert.ok(d.getElementById('stop').classList.contains('hidden'));

  // next question carries the history
  d.getElementById('input').value = 'e a multa?';
  d.getElementById('form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
  await tick();
  assert.strictEqual(calls.at(-1)[0], 'ask');
  finishAsk({ answer: 'ok', sources: [] });
  await tick();
});

test('chat: model output is never rendered as HTML, errors are shown', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { window, handlers } = boot();
  await tick();
  const d = window.document;
  window.api.ask = () => Promise.reject(new Error("Error invoking remote method 'chat:ask': Error: Chat HTTP 500: boom"));
  d.getElementById('input').value = 'oi';
  d.getElementById('form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
  handlers.delta('<img src=x onerror=alert(1)> **ok**');
  await tick(80);
  const msg = d.querySelector('.msg.assistant');
  assert.strictEqual(msg.querySelectorAll('img').length, 0);
  assert.ok(msg.classList.contains('error'));
  assert.match(msg.textContent, /Error:.*Chat HTTP 500: boom/);
  assert.ok(!/Error invoking remote method/.test(msg.textContent), 'IPC prefix stripped');
});

test('aba Instalação: lista dependências e pede confirmação ao instalar', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { window, calls } = boot();
  await tick();
  const d = window.document;
  d.querySelector('#tabs button[data-tab="setup"]').click();
  assert.ok(!d.querySelector('[data-panel="setup"]').classList.contains('hidden'));
  const rows = d.querySelectorAll('#deps-list .dep-row');
  assert.strictEqual(rows.length, 2);
  assert.match(rows[0].textContent, /OCR.*missing.*Install/);
  assert.match(rows[1].textContent, /installed/);
  assert.ok(d.querySelector('[data-panel="setup"] [data-s="ocr.enabled"]'), 'OCR settings live in the Instalação tab');
  assert.ok(!d.querySelector('[data-panel="knowledge"] [data-s="ocr.enabled"]'));
  d.getElementById('ocr-check').click();
  await tick();
  assert.match(d.getElementById('ocr-status').textContent, /tesseract: ok · pdftoppm: not found/);
  assert.strictEqual(d.querySelectorAll('#deps-list button').length, 1, 'só o item faltando tem botão');
  assert.match(d.getElementById('deps-status').textContent, /1 item\(s\) missing.*apt-get/);
  d.querySelector('#deps-list button').click();
  await tick();
  assert.strictEqual(JSON.stringify(calls.at(-1)), '["install",["tesseract"]]');
  assert.match(d.getElementById('deps-status').textContent, /Cancelled/);
});

test('servidor: um clique em Iniciar mostra "iniciando…" na hora e bloqueia novo clique', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { window, calls, finishStart } = boot();
  await tick();
  const d = window.document;
  const block = d.querySelector('.srv[data-which="chat"]');
  const btn = block.querySelector('.start');
  btn.click();
  await tick();
  assert.strictEqual(block.querySelector('.badge').textContent, 'starting…');
  assert.ok(btn.disabled, 'botão bloqueado enquanto inicia');
  btn.click(); // segundo clique é ignorado
  await tick();
  assert.strictEqual(calls.filter((c) => c[0] === 'start').length, 1);
  finishStart();
  await tick();
  assert.strictEqual(block.querySelector('.badge').textContent, 'running');
});

test('limite de tokens da pergunta: contador abaixo da caixa e envio bloqueado acima do limite', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { window, calls } = boot();
  await tick();
  const d = window.document;
  const input = d.getElementById('input');
  assert.strictEqual(d.querySelector('[data-s="maxInputTokens"]').value, '20');
  input.value = 'olá mundo'; // 9 chars -> ~3 tokens
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.match(d.getElementById('token-count').textContent, /~3 \/ 20 tokens$/);
  assert.strictEqual(d.getElementById('send').disabled, false);

  input.value = 'x'.repeat(100); // ~29 tokens > 20
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.match(d.getElementById('token-count').textContent, /over the limit/);
  assert.ok(d.getElementById('token-count').classList.contains('over'));
  assert.ok(d.getElementById('send').disabled);
  d.getElementById('form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
  await tick();
  assert.ok(!calls.some((c) => c[0] === 'ask'), 'nada é enviado acima do limite');
  assert.strictEqual(input.value.length, 100, 'o texto não é apagado');
});

test('language selector: English by default; switching to pt/es re-translates the UI and saves the setting', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { window, calls } = boot('en');
  await tick();
  const d = window.document;
  const sel = d.getElementById('lang');
  assert.strictEqual(sel.value, 'en');
  assert.strictEqual(d.documentElement.lang, 'en');
  assert.strictEqual(d.querySelector('#tabs button[data-tab="servers"]').textContent, 'Servers');
  assert.strictEqual(d.getElementById('input').placeholder.startsWith('Ask, chat'), true);

  sel.value = 'pt';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(40);
  assert.strictEqual(JSON.stringify(calls.filter((c) => c[0] === 'save').at(-1)[1]), '{"language":"pt"}');
  assert.strictEqual(d.documentElement.lang, 'pt');
  assert.strictEqual(d.querySelector('#tabs button[data-tab="servers"]').textContent, 'Servidores');
  assert.match(d.getElementById('stats').textContent, /3 arquivos · 9 trechos/);
  assert.strictEqual(d.querySelector('.srv[data-which="embed"] .badge').textContent, 'rodando');
  assert.strictEqual(d.querySelector('.srv[data-which="chat"] .srv-title').textContent, 'Chat');
  const link = d.getElementById('models-help').querySelector('a');
  assert.strictEqual(link.href, 'https://huggingface.co/mozilla-ai/llamafile_0.10', 'rich text keeps the link');

  sel.value = 'es';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(40);
  assert.strictEqual(d.querySelector('#tabs button[data-tab="servers"]').textContent, 'Servidores');
  assert.strictEqual(d.querySelector('#tabs button[data-tab="memory"]').textContent, 'Memoria');
  assert.match(d.getElementById('vweight-val').textContent, /Vectores 60%/);
});

test('language setting from saved settings is applied at startup', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { window } = boot('es');
  await tick();
  assert.strictEqual(window.document.getElementById('lang').value, 'es');
  assert.strictEqual(window.document.querySelector('#tabs button[data-tab="search"]').textContent, 'Búsqueda');
});
