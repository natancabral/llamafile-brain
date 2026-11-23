'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { zipSync, strToU8 } = require('fflate');

const { BrainDB } = require('../src/core/db');
const { indexFolders } = require('../src/core/indexer');
const { ask, retrieve } = require('../src/core/rag');
const { listFiles, detectIntent } = require('../src/core/summarize');
const { parseMemoryCommand } = require('../src/core/memory');
const { parseEvalSet, runEval } = require('../src/core/evalset');
const { ocrImage, ocrPdf, ocrStatus } = require('../src/core/ocr');
const { fakeEmbed, startMock, tmpdir, baseSettings } = require('./helpers');

const write = (dir, rel, content) => {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
};
const writeOdt = (f, paras) =>
  fs.writeFileSync(f, zipSync({ 'content.xml': strToU8(`<office:text>${paras.map((p) => `<text:p>${p}</text:p>`).join('')}</office:text>`) }));
const writeDocx = (f, paras) =>
  fs.writeFileSync(f, zipSync({ 'word/document.xml': strToU8(`<w:body>${paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body>`) }));

// ============================================================ indexer
test('indexer: roots/kinds, secrets, ignore patterns, odt/docx, incremental (mtime + hash), purge', async () => {
  const mock = await startMock();
  const docs = tmpdir();
  const brain = tmpdir();
  write(docs, 'billing.md', '# Cobrança\nO sistema de cobrança usa Pix e boleto.\n');
  write(docs, 'auth.js', 'function login(user){ return jwtSign(user); }\n');
  write(docs, '.env', 'API_KEY=supersecret');
  write(docs, 'server.key', 'PRIVATE');
  write(docs, 'node_modules/x.js', 'ignored');
  write(docs, 'prontuario/exame.md', 'dado sensível de saúde');
  write(docs, 'foto.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
  write(docs, 'x.zip', Buffer.from([0x50, 0x4b, 3, 4]));
  writeOdt(path.join(docs, 'Oracoes.odt'), ['Pai nosso &amp; outras', 'segunda linha']);
  writeDocx(path.join(docs, 'CV.docx'), ['Natan Cabral', 'Tech Lead &lt;20 anos&gt;']);
  fs.writeFileSync(path.join(docs, 'vazio.docx'), zipSync({ 'word/document.xml': strToU8('<w:body></w:body>') }));
  write(brain, 'nota.md', '# Nota\nMinha decisão: usar pnpm.\n');
  write(brain, 'memory.md', '# Memory\n- gerado pelo app');

  const db = new BrainDB(':memory:');
  const run = (roots, ignore = ['prontuario', '*.zip']) =>
    indexFolders({ roots, db, embedUrl: mock.url, ignore });
  const roots = [{ dir: brain, kind: 'brain' }, { dir: docs, kind: 'doc' }];

  let r = await run(roots);
  const names = db.listFiles().map((f) => path.basename(f.path)).sort();
  assert.deepStrictEqual(names, ['CV.docx', 'Oracoes.odt', 'auth.js', 'billing.md', 'nota.md']);
  assert.strictEqual(db.getFile(path.join(brain, 'nota.md')).kind, 'brain');
  assert.strictEqual(db.getFile(path.join(docs, 'auth.js')).kind, 'doc');
  assert.deepStrictEqual(r.skipped, { '.png': 1 }, 'zip is ignored by pattern, png is unsupported without OCR');
  assert.ok(r.failed.length === 1 && r.failed[0].startsWith('vazio.docx'), r.failed.join());
  const all = db.db.prepare('SELECT text FROM chunks').all().map((x) => x.text).join('\n');
  assert.ok(all.includes('Pai nosso & outras') && all.includes('Tech Lead <20 anos>'), 'xml entities decoded');
  assert.ok(!all.includes('supersecret') && !all.includes('saúde') && !all.includes('gerado pelo app'));

  // incremental: unchanged files are not even read or embedded
  const calls = mock.seen.embedCalls;
  r = await run(roots);
  assert.strictEqual(r.indexed, 0);
  assert.strictEqual(mock.seen.embedCalls, calls);

  // same content, new mtime -> hash check, still no embedding
  const billing = path.join(docs, 'billing.md');
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(billing, later, later);
  r = await run(roots);
  assert.strictEqual(r.indexed, 0);
  assert.strictEqual(mock.seen.embedCalls, calls);

  // changed content -> re-embedded
  write(docs, 'billing.md', '# Cobrança\nAgora também aceitamos cartão de crédito.\n');
  const later2 = new Date(Date.now() + 120000);
  fs.utimesSync(billing, later2, later2);
  r = await run(roots);
  assert.strictEqual(r.indexed, 1);
  assert.ok(db.search({ queryText: 'cartao credito' })[0].text.includes('cartão'));

  // deleted file disappears; removed root is purged
  fs.unlinkSync(path.join(docs, 'auth.js'));
  r = await run(roots);
  assert.ok(!db.listFiles().some((f) => f.path.endsWith('auth.js')));
  r = await run([{ dir: brain, kind: 'brain' }]);
  assert.deepStrictEqual(db.listFiles().map((f) => path.basename(f.path)), ['nota.md']);

  db.close();
  mock.server.close();
});

// ============================================================ OCR
function fakeTools(dir, { tesseract = true, pdftoppm = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (tesseract) {
    fs.writeFileSync(path.join(dir, 'tesseract'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "tesseract fake" >&2; exit 0; fi\necho "TEXTO OCR de $(basename "$1")"\n', { mode: 0o755 });
  }
  if (pdftoppm) {
    fs.writeFileSync(path.join(dir, 'pdftoppm'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pdftoppm fake" >&2; exit 0; fi\nfor last; do :; done\necho png > "${last}-1.png"\n', { mode: 0o755 });
  }
  return dir;
}
async function withPath(dir, fn) {
  const old = process.env.PATH;
  process.env.PATH = dir;
  try {
    return await fn();
  } finally {
    process.env.PATH = old;
  }
}

test('OCR in the indexer: images and scanned PDFs are read when enabled; clear warning when tesseract is missing', { skip: process.platform === 'win32' && 'usa scripts /bin/sh' }, async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const docs = tmpdir();
  write(docs, 'foto.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
  write(docs, 'scan.pdf', '%PDF-1.4 not really text'); // no extractable text -> OCR fallback
  write(docs, 'nota.md', '# Nota\nTexto normal.\n');
  const roots = [{ dir: docs, kind: 'doc' }];

  // OCR off: png skipped, scanned pdf listed as failed
  let db = new BrainDB(':memory:');
  let r = await indexFolders({ roots, db, embedUrl: mock.url, ocr: { enabled: false } });
  assert.deepStrictEqual(r.skipped, { '.png': 1 });
  assert.ok(r.failed.some((f) => f.startsWith('scan.pdf')));
  db.close();

  // OCR on with fake tools
  db = new BrainDB(':memory:');
  r = await withPath(`${fakeTools(tmpdir())}:/usr/bin:/bin`, () =>
    indexFolders({ roots, db, embedUrl: mock.url, ocr: { enabled: true, lang: 'por+eng', maxPages: 5 } }),
  );
  assert.deepStrictEqual(r.warnings, []);
  assert.deepStrictEqual(r.skipped, {});
  const text = db.db.prepare('SELECT text FROM chunks').all().map((x) => x.text).join('\n');
  assert.ok(text.includes('TEXTO OCR de foto.png'), 'image OCR');
  assert.ok(text.includes('TEXTO OCR de p-1.png'), 'scanned PDF rendered with pdftoppm then OCR');
  db.close();

  // OCR on but tesseract missing: friendly warning, indexing continues
  db = new BrainDB(':memory:');
  r = await withPath(tmpdir(), () => indexFolders({ roots, db, embedUrl: mock.url, ocr: { enabled: true } }));
  assert.ok(r.warnings.some((w) => /tesseract/.test(w)));
  assert.ok(db.listFiles().some((f) => f.path.endsWith('nota.md')));
  db.close();
  mock.server.close();
});

test('OCR with the REAL tesseract/pdftoppm (skipped when not installed)', async (t) => {
  const st = await ocrStatus();
  let langs = '';
  try {
    langs = execFileSync('tesseract', ['--list-langs'], { encoding: 'utf8' });
  } catch {
    /* not installed */
  }
  if (!st.tesseract || !st.pdftoppm || !/\beng\b/.test(langs)) return t.skip('tesseract/pdftoppm/eng not available');
  const dir = tmpdir();
  const png = path.join(dir, 'texto.png');
  const pdf = path.join(dir, 'scan.pdf');
  try {
    execFileSync('python3', ['-c', `
from PIL import Image, ImageDraw, ImageFont
img = Image.new('RGB', (900, 200), 'white')
d = ImageDraw.Draw(img)
try:
    f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 48)
except Exception:
    f = ImageFont.load_default(48)
d.text((20, 60), 'Invoice total 4521 paid', fill='black', font=f)
img.save(${JSON.stringify(png)})
img.save(${JSON.stringify(pdf)}, 'PDF', resolution=150)
`]);
  } catch {
    return t.skip('PIL not available to create the test image');
  }
  const fromImage = await ocrImage(png, { lang: 'eng' });
  assert.match(fromImage, /Invoice total 4521 paid/i);
  const fromPdf = await ocrPdf(pdf, { lang: 'eng', maxPages: 2 });
  assert.match(fromPdf, /Invoice total 4521 paid/i);
});

// ============================================================ memory + rag
async function indexedDb(mock, files) {
  const dir = tmpdir();
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  const db = new BrainDB(':memory:');
  await indexFolders({ roots: [{ dir, kind: 'doc' }], db, embedUrl: mock.url });
  return { db, dir };
}

test('memory commands run in code (no model call) and can be turned off (pt)', async () => {
  require('../src/shared/i18n').setLang('pt');
  try {
    await memoryCommandsPt();
  } finally {
    require('../src/shared/i18n').setLang('en');
  }
});

test('memory commands in English and Spanish', async () => {
  const I18N = require('../src/shared/i18n');
  const mock = await startMock();
  const db = new BrainDB(':memory:');
  const settings = baseSettings(mock.url);
  const say = async (q) => (await ask({ question: q, db, settings })).answer;
  try {
    assert.match(await say('remember that my name is Ana'), /Saved/);
    assert.match(await say('remember that my name is ana'), /Already saved/);
    assert.match(await say('what do you remember about me?'), /What is in memory \(1\).*my name is Ana/s);
    assert.match(await say('forget #1'), /Forgotten/);
    assert.match(await say('forget everything'), /Erase all memory/);
    I18N.setLang('es');
    assert.match(await say('recuerda que me llamo Ana'), /Guardado/);
    assert.match(await say('qué recuerdas'), /Qué hay en la memoria/);
    assert.match(await say('olvida #2'), /Olvidado/);
    assert.strictEqual(mock.seen.chatBodies.length, 0, 'the model was never called');
  } finally {
    I18N.setLang('en');
    db.close();
    mock.server.close();
  }
});

async function memoryCommandsPt() {
  const mock = await startMock();
  const db = new BrainDB(':memory:');
  const settings = baseSettings(mock.url);
  const say = async (q, s = settings) => (await ask({ question: q, db, settings: s })).answer;

  assert.match(await say('lembre que meu nome é Natan'), /Anotado/);
  assert.match(await say('anote: uso pnpm nos projetos'), /Anotado/);
  assert.match(await say('lembre que meu nome é natan'), /Já estava anotado/);
  assert.strictEqual(db.listMemories().length, 2);
  assert.strictEqual(mock.seen.chatBodies.length, 0, 'the model was never called');

  const shown = await say('o que você lembra de mim?');
  assert.ok(shown.includes('meu nome é Natan') && shown.includes('uso pnpm') && shown.includes('- **#'), 'markdown list');

  assert.match(await say('esqueça pnpm'), /Esquecido/);
  assert.strictEqual(db.listMemories().length, 1);
  assert.match(await say('esqueça #999'), /Não encontrei/);
  assert.match(await say('esqueça tudo'), /Apagar toda a memória/);
  assert.strictEqual(db.listMemories().length, 1, '"forget everything" never wipes by command');
  assert.match(await say('esqueça zzz'), /Não encontrei/);

  db.addMemory('moro em São Paulo');
  db.addMemory('moro perto do metrô');
  assert.match(await say('esqueça moro'), /2 memórias/, 'ambiguous forget asks which one');
  assert.strictEqual(db.listMemories().length, 3);

  // memory off: commands are ordinary chat text
  await say('lembre que x y z', { ...settings, memory: { enabled: false } });
  assert.strictEqual(mock.seen.chatBodies.length, 1);
  assert.strictEqual(db.listMemories().length, 3);
  db.close();
  mock.server.close();
}

test('profile and memories reach the system prompt; budget picks relevant memories', async () => {
  const mock = await startMock();
  const db = new BrainDB(':memory:');
  db.addMemory('Sempre usamos pnpm e nunca npm neste projeto');
  for (let i = 0; i < 30; i++) db.addMemory(`fato irrelevante número ${i} sobre jardinagem e plantas ornamentais de interior`);
  const settings = baseSettings(mock.url, { profile: 'Meu nome é Natan. Prefiro respostas curtas.', memory: { enabled: true, maxChars: 400 } });

  await ask({ question: 'qual gerenciador de pacotes pnpm devo usar?', db, settings });
  const system = mock.seen.chatBodies.at(-1).messages[0].content;
  assert.ok(system.includes('User profile') && system.includes('Prefiro respostas curtas'));
  assert.ok(system.includes('usamos pnpm'), 'the relevant (older) memory was selected despite the budget');
  assert.ok(system.length < 3000, 'budget respected');
  assert.ok(/Markdown/.test(system), 'the model is told to answer in Markdown');
  db.close();
  mock.server.close();
});

test('rag: grounded answer with citations, plain chat without index, useFiles=false', async () => {
  const mock = await startMock();
  const { db } = await indexedDb(mock, {
    'billing.md': '# Cobrança\nAgora também aceitamos cartão de crédito.\n',
    'reuniao.md': '# Reunião\nPlanejamento na terça com o time de pagamentos.\n',
  });
  const settings = baseSettings(mock.url);

  const r = await ask({ question: 'aceitamos cartão de crédito?', db, settings });
  assert.strictEqual(r.answer, 'Resposta [1]');
  assert.ok(r.sources[0].path.endsWith('billing.md'));
  let msgs = mock.seen.chatBodies.at(-1).messages;
  assert.ok(msgs.at(-1).content.includes('cartão de crédito') && msgs[0].content.includes('ignore the excerpts'));

  const quiet = await startMock({ chatReply: 'Sem citações aqui' });
  const r2 = await ask({ question: 'quanto é 1 + 1?', db, settings: { ...settings, chat: { url: quiet.url, model: 'local' } } });
  assert.deepStrictEqual(r2.sources, [], 'sources only when the answer cites them');
  quiet.server.close();

  const calls = mock.seen.embedCalls;
  await ask({ question: 'quanto é 1 + 1?', db, settings: { ...settings, useFiles: false } });
  msgs = mock.seen.chatBodies.at(-1).messages;
  assert.strictEqual(msgs.at(-1).content, 'quanto é 1 + 1?');
  assert.strictEqual(mock.seen.embedCalls, calls);

  const empty = new BrainDB(':memory:');
  await ask({ question: 'calcule: 1 + 1', db: empty, settings });
  msgs = mock.seen.chatBodies.at(-1).messages;
  assert.strictEqual(msgs.at(-1).content, 'calcule: 1 + 1');
  assert.ok(!/SOMENTE/.test(msgs[0].content) && /do math/.test(msgs[0].content));
  mock.server.close();
});
test('retrieval falls back to keyword search when the embedding server is down', async () => {
  const mock = await startMock();
  const { db } = await indexedDb(mock, { 'contrato.md': '# Contrato\nO prazo do contrato é de doze meses.\n' });
  const warns = [];
  const settings = baseSettings(mock.url, { embed: { url: 'http://127.0.0.1:1', model: 'local' } });
  const hits = await retrieve({ question: 'prazo do contrato', db, settings, onWarn: (w) => warns.push(w) });
  assert.ok(hits[0].path.endsWith('contrato.md'));
  assert.ok(warns.some((w) => /keyword/.test(w)));
  mock.server.close();
});

test('reranker reorders candidates; failures fall back to the hybrid order', async () => {
  const mock = await startMock({ rerank: 'reverse' });
  const { db } = await indexedDb(mock, {
    'a.md': '# A\nplano de vendas do primeiro trimestre\n',
    'b.md': '# B\nplano de marketing do segundo trimestre\n',
    'c.md': '# C\nplano de contratação do terceiro trimestre\n',
  });
  const q = 'plano trimestre';
  const base = baseSettings(mock.url, { topK: 3 });
  const plain = await retrieve({ question: q, db, settings: base });
  assert.strictEqual(plain.length, 3);

  const withRr = await retrieve({ question: q, db, settings: { ...base, rerank: { enabled: true, url: mock.url, model: 'local', candidates: 3 } } });
  assert.deepStrictEqual(withRr.map((h) => h.path), [...plain].reverse().map((h) => h.path));
  assert.strictEqual(mock.seen.rerankCalls, 1);
  mock.server.close();

  const bad = await startMock({ rerank: 'fail' });
  const warns = [];
  const fallback = await retrieve({
    question: q, db, settings: { ...base, embed: { url: bad.url }, rerank: { enabled: true, url: bad.url, candidates: 3 } },
    onWarn: (w) => warns.push(w),
  });
  assert.strictEqual(fallback.length, 3);
  assert.ok(warns.some((w) => /Rerank failed/.test(w)));
  bad.server.close();
});

test('list / summary intents produce Markdown from the index', async () => {
  const mock = await startMock();
  const { db, dir } = await indexedDb(mock, {
    'Documents/CV.md': '# CV\nNatan, tech lead.\n',
    'Documents/Oracoes.md': '# Orações\nPai nosso.\n',
  });
  const docsRoot = path.join(dir, 'Documents');
  const settings = baseSettings(mock.url, { folders: [docsRoot] });

  assert.strictEqual(detectIntent('Quero que leio os arquivos do Documents e me faça um resumo'), 'summary');
  assert.strictEqual(detectIntent('acesse e liste os arquivos'), 'list');
  assert.strictEqual(detectIntent('como funciona o login?'), null);

  const listed = listFiles({ db, settings });
  assert.ok(listed.answer.startsWith('**Indexed files (2):**'));
  assert.ok(listed.answer.includes('- `Documents/CV.md`'));

  let streamed = '';
  const before = mock.seen.chatBodies.length;
  const res = await ask({ question: 'resuma os arquivos', db, settings, onDelta: (d) => (streamed += d) });
  assert.strictEqual(res.answer, streamed);
  assert.ok(streamed.includes('- **Documents/CV.md**') && streamed.includes('## Overview'));
  assert.strictEqual(mock.seen.chatBodies.length - before, 3, '2 per-file summaries + 1 overview');

  const emptyAnswer = await ask({ question: 'liste os arquivos', db: new BrainDB(':memory:'), settings });
  assert.ok(emptyAnswer.answer.includes('Index now'));
  mock.server.close();
});

// ============================================================ memory parsing + eval set
test('memory command parsing: imperatives only, never plain questions or similar words', () => {
  const p = (t) => parseMemoryCommand(t);
  assert.deepStrictEqual(p('lembre que meu nome é Natan'), { type: 'remember', text: 'meu nome é Natan' });
  assert.deepStrictEqual(p('lembre-se de que moro em SP'), { type: 'remember', text: 'moro em SP' });
  assert.deepStrictEqual(p('anote: usar pnpm'), { type: 'remember', text: 'usar pnpm' });
  assert.deepStrictEqual(p('esqueça que usar pnpm'), { type: 'forget', text: 'usar pnpm' });
  assert.deepStrictEqual(p('esqueça #3'), { type: 'forget', text: '#3' });
  assert.deepStrictEqual(p('o que você lembra de mim?'), { type: 'show' });
  assert.deepStrictEqual(p('apague a memória'), { type: 'forget_all' });
  for (const t of ['Lembrete de reunião amanhã', 'lembra do que falamos?', 'quanto é 1+1', 'explique o arquivo auth.js']) {
    assert.strictEqual(p(t), null, t);
  }
});

test('evaluation set: parse + hit rate / MRR through the real retrieval', async () => {
  const mock = await startMock();
  const { db } = await indexedDb(mock, {
    'contrato.md': '# Contrato\nO prazo do contrato é de doze meses.\n',
    'receitas.md': '# Receitas\nBolo de cenoura com cobertura de chocolate.\n',
  });
  const settings = baseSettings(mock.url);
  const text = '# comentário\nQual o prazo do contrato? => contrato\nComo fazer bolo de cenoura? => cenoura\nPergunta sem resposta quântica => inexistente\nlinha inválida';
  assert.strictEqual(parseEvalSet(text).length, 3);
  const r = await runEval(text, (q) => retrieve({ question: q, db, settings }));
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.results[0].rank, 1);
  assert.strictEqual(r.results[1].rank, 1);
  assert.strictEqual(r.results[2].rank, 0);
  assert.ok(Math.abs(r.hitRate - 2 / 3) < 1e-9 && Math.abs(r.mrr - 2 / 3) < 1e-9);
  mock.server.close();
});

test('setup: comandos de instalação por sistema/gerenciador', () => {
  const { installCommand, detectManager, PACKAGES } = require('../scripts/setup');
  assert.deepStrictEqual(installCommand('tesseract', 'apt-get', { root: false, platform: 'linux' }), ['sudo', 'apt-get', 'install', '-y', 'tesseract-ocr', 'tesseract-ocr-por']);
  assert.deepStrictEqual(installCommand('poppler', 'apt-get', { root: true, platform: 'linux' }), ['apt-get', 'install', '-y', 'poppler-utils']);
  assert.deepStrictEqual(installCommand('libreoffice', 'brew', { platform: 'darwin' }), ['brew', 'install', '--cask', 'libreoffice']);
  assert.strictEqual(installCommand('tesseract', 'winget', { platform: 'win32' })[4], 'UB-Mannheim.TesseractOCR');
  for (const item of Object.keys(PACKAGES)) for (const m of ['apt-get', 'dnf', 'pacman', 'zypper', 'brew', 'winget', 'choco', 'scoop']) assert.ok(installCommand(item, m, { platform: 'linux' }), `${item}/${m}`);
  assert.strictEqual(detectManager('darwin', (c) => c === 'brew'), 'brew');
  assert.strictEqual(detectManager('win32', (c) => c === 'choco'), 'choco');
  assert.strictEqual(detectManager('linux', (c) => c === 'dnf'), 'dnf');
  assert.strictEqual(detectManager('darwin', () => false), null);
});

test('indexação: sem progresso por idleTimeoutMs cancela com mensagem clara; ~$ lock files são ignorados', async (t) => {
  const http = require('node:http');
  const fs = require('node:fs');
  const path = require('node:path');
  const { indexFolders } = require('../src/core/indexer');
  const { BrainDB } = require('../src/core/db');
  const hang = http.createServer(() => {}); // aceita a conexão e nunca responde
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  t.after(() => { hang.closeAllConnections?.(); hang.close(); });
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lfb-idle-'));
  fs.writeFileSync(path.join(dir, 'a.md'), '# A\ntexto para indexar\n');
  fs.writeFileSync(path.join(dir, '~$lock.docx'), 'lixo do Word');
  const db = new BrainDB(':memory:');
  const t0 = Date.now();
  await assert.rejects(
    () => indexFolders({ roots: [{ dir, kind: 'doc' }], db, embedUrl: `http://127.0.0.1:${hang.address().port}`, embedModel: 'x', idleTimeoutMs: 600 }),
    /no progress in 1 s.*a\.md/s,
  );
  assert.ok(Date.now() - t0 < 5000);
});

test('external server "Start" really checks the URL and the model', async () => {
  const { checkExternal } = require('../src/core/client');
  const mock = await startMock();
  try {
    assert.deepStrictEqual(await checkExternal('chat', mock.url, 'local'), {});
    const e = await checkExternal('embed', mock.url, 'local');
    assert.ok(e.dim > 0);
    await checkExternal('rerank', mock.url);
    await assert.rejects(() => checkExternal('embed', 'http://127.0.0.1:1', 'x'), /Could not connect/);
    await assert.rejects(() => checkExternal('chat', 'http://127.0.0.1:1', 'x'), /Could not connect/);
    await assert.rejects(() => checkExternal('chat', '', 'x'), /URL/);
  } finally {
    mock.server.close();
  }
});

// ============================================================ error log + pause
test('indexer: a too-large file is logged (path, size, reason) and does not stop the run; pause waits and resumes', async () => {
  const { ErrorLog } = require('../src/core/errorlog');
  const mock = await startMock();
  const docs = tmpdir();
  write(docs, 'ok.md', '# Ok\nconteudo pequeno e valido\n');
  const big = write(docs, 'enorme.txt', 'a'.repeat(1024 * 1024 + 10));
  const elog = new ErrorLog(path.join(tmpdir(), 'errors.sqlite'));
  const db = new BrainDB(':memory:');
  const roots = [{ dir: docs, kind: 'doc' }];

  let paused = true;
  setTimeout(() => (paused = false), 900);
  const t0 = Date.now();
  const r = await indexFolders({ roots, db, embedUrl: mock.url, errorLog: elog, isPaused: () => paused });
  assert.ok(Date.now() - t0 >= 800, 'waited while paused');
  assert.equal(r.indexed, 1);
  const rows = elog.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, big);
  assert.equal(rows[0].kind, 'too_large');
  assert.ok(rows[0].size > 1024 * 1024 && rows[0].limit === 1024 * 1024);

  // indexing log: what was indexed and what was captured
  const files = db.listIndexedFiles();
  assert.equal(files.length, 1);
  assert.equal(files[0].action, 'indexed');
  assert.ok(files[0].chunks >= 1 && files[0].chars > 0);
  assert.match(db.fileChunks(files[0].path)[0].text, /conteudo pequeno/);
  assert.equal(db.listIndexedFiles('ok.md').length, 1);
  assert.equal(db.listIndexedFiles('nada%').length, 0);
  assert.match(db.listIndexLog()[0].preview, /conteudo/);

  // re-running only refreshes the same row; deleting the file prunes it
  await indexFolders({ roots, db, embedUrl: mock.url, errorLog: elog });
  assert.equal(elog.count(), 1);
  fs.unlinkSync(big);
  await indexFolders({ roots, db, embedUrl: mock.url, errorLog: elog });
  assert.equal(elog.count(), 0);
  elog.close();
  db.close();
  mock.server.close();
});

// ============================================================ huge files (stream, keyword-only) + block vector scan
test('indexer: big .sql and SQLite files are streamed keyword-only (no embeddings) and found by keyword search', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const mock = await startMock();
  const docs = tmpdir();
  const lines = ['CREATE TABLE clientes (id INTEGER, nome TEXT);'];
  for (let i = 0; i < 40000; i++) lines.push(`INSERT INTO clientes VALUES (${i}, 'cliente numero ${i} zebra');`);
  const sql = write(docs, 'dump.sql', lines.join('\n') + '\n'); // > 1 MB
  assert.ok(fs.statSync(sql).size > 1024 * 1024);
  const dbf = path.join(docs, 'dados.sqlite');
  const sdb = new DatabaseSync(dbf);
  sdb.exec('CREATE TABLE produtos (id INTEGER PRIMARY KEY, nome TEXT, preco REAL)');
  const ins = sdb.prepare('INSERT INTO produtos(nome, preco) VALUES (?, ?)');
  for (let i = 0; i < 300; i++) ins.run(i === 150 ? 'unicornio raro' : `item ${i}`, i);
  sdb.close();

  const db = new BrainDB(':memory:');
  const elog = new (require('../src/core/errorlog').ErrorLog)(path.join(tmpdir(), 'e.sqlite'));
  const r = await indexFolders({ roots: [{ dir: docs, kind: 'doc' }], db, embedUrl: mock.url, errorLog: elog });
  assert.equal(r.indexed, 2);
  assert.equal(mock.seen.embedCalls, 0, 'no embeddings for streamed files');
  assert.equal(elog.count(), 0);
  const hit = db.search({ queryText: 'unicornio', limit: 3 });
  assert.ok(hit.length && /unicornio raro/.test(hit[0].text) && hit[0].path.endsWith('dados.sqlite'));
  assert.ok(db.search({ queryText: 'clientes', limit: 3 }).some((h) => h.path === sql));
  // unchanged on the second run
  const r2 = await indexFolders({ roots: [{ dir: docs, kind: 'doc' }], db, embedUrl: mock.url });
  assert.equal(r2.unchanged, 2);
  elog.close();
  db.close();
  mock.server.close();
});

test('db: block vector scan returns the same top results as the in-memory scan', () => {
  const db = new BrainDB(':memory:');
  const vecs = [];
  const chunks = [];
  for (let i = 0; i < 300; i++) {
    chunks.push({ start: 1, end: 1, text: `chunk ${i}` });
    vecs.push(Array.from({ length: 16 }, (_, j) => Math.sin(i * 7 + j * 3)));
  }
  db.addFile({ path: '/x.txt', hash: 'h', mtime: 1, size: 1, kind: 'doc', chunks, vectors: vecs });
  const q = vecs[42].map((x) => x + 0.01);
  const a = db._vectorRank(q, 5).map((x) => x.id);
  const b = db._vectorRankBlocks(q, 5).map((x) => x.id);
  assert.deepEqual(b, a);
  db.close();
});

// ============================================================ anti-hallucination: refuse without evidence, confidence badge
test('rag: a question about the files with no relevant excerpt is refused without calling the model; answers carry a confidence', async () => {
  const mock = await startMock({ chatReply: 'Resposta baseada no trecho [1].' });
  const docs = tmpdir();
  write(docs, 'cobranca.md', '# Cobrança\nO sistema de cobrança usa Pix e boleto bancário.\n');
  const db = new BrainDB(':memory:');
  await indexFolders({ roots: [{ dir: docs, kind: 'doc' }], db, embedUrl: mock.url });
  const settings = baseSettings(mock.url);

  // relevant: the excerpt is used, the answer gets a percentage
  let r = await ask({ question: 'como funciona a cobrança com pix e boleto?', history: [], db, settings });
  assert.ok(r.confidence && r.confidence.pct > 0 && r.confidence.pct <= 95, JSON.stringify(r.confidence));
  const used = mock.seen.chatBodies.length;
  assert.ok(used >= 1);
  assert.ok(mock.seen.chatBodies[used - 1].temperature <= 0.1, 'grounded answers use a low temperature');
  assert.match(JSON.stringify(mock.seen.chatBodies[used - 1].messages[0].content), /Never invent/);

  // about the files but nothing relevant: refused, the model is not called
  const strictQ = 'o que dizem meus documentos sobre astronomia e buracos negros?';
  r = await ask({ question: strictQ, history: [], db, settings: baseSettings(mock.url, { grounding: { strict: true, minCos: 0.9 } }) });
  assert.equal(r.confidence.pct, 0);
  assert.equal(mock.seen.chatBodies.length, used, 'model not called');
  assert.match(r.answer, /não vou chutar|won't guess|no voy a adivinar/i);

  db.close();
  mock.server.close();
});

test('indexer: FTS shadow tables of a SQLite file are skipped; keyword-only evidence is usable', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { assessEvidence } = require('../src/core/rag');
  const mock = await startMock();
  const docs = tmpdir();
  const f = path.join(docs, 'k.sqlite3');
  const sdb = new DatabaseSync(f);
  sdb.exec("CREATE VIRTUAL TABLE knowledge USING fts5(body); INSERT INTO knowledge(body) VALUES ('sprint act 34 decisao importante');");
  sdb.close();
  const db = new BrainDB(':memory:');
  await indexFolders({ roots: [{ dir: docs, kind: 'doc' }], db, embedUrl: mock.url });
  const titles = db.db.prepare('SELECT DISTINCT title FROM chunks').all().map((r) => r.title).join('|');
  assert.ok(/table knowledge/.test(titles));
  assert.ok(!/knowledge_(content|data|idx|docsize|config)/.test(titles.replace(/schema: table knowledge_\w+/g, '')), titles);
  assert.ok(assessEvidence([{ cos: 0.2 }, { bm25: -9 }]).usable, 'strong keyword hit without a vector counts');
  assert.ok(!assessEvidence([{ cos: 0.2 }, { bm25: -0.4 }]).usable);
  db.close();
  mock.server.close();
});
