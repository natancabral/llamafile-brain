'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { chunkText, chunkDocument } = require('../src/core/chunker');
const { BrainDB } = require('../src/core/db');
const { embed, chatStream } = require('../src/core/client');
const { splitArgs } = require('../src/core/llamafile');
const { fakeEmbed, startMock, tmpdir } = require('./helpers');

test('chunkText keeps correct line ranges and overlap; splits giant lines', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1} ${'x'.repeat(30)}`).join('\n');
  const chunks = chunkText(text, { maxChars: 300, overlapChars: 80 });
  assert.ok(chunks.length > 3);
  assert.strictEqual(chunks[0].start, 1);
  assert.strictEqual(chunks.at(-1).end, 100);
  const lines = text.split('\n');
  for (const c of chunks) assert.strictEqual(c.text, lines.slice(c.start - 1, c.end).join('\n').trim());
  for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i].start <= chunks[i - 1].end + 1, 'no gaps');
  const big = chunkText('a'.repeat(5000), { maxChars: 1000 });
  assert.ok(big.length >= 5 && big.every((c) => c.text.length <= 1000));
});

test('chunkDocument: markdown by headings (title path) and code by declarations', () => {
  const md = '# Contrato\nIntro do contrato.\n\n## Prazo\nO prazo é de 12 meses.\n\n## Multa\nA multa é de 10%.\n';
  const mdChunks = chunkDocument(md, 'a.md', { maxChars: 60, overlapChars: 10, minChars: 0 });
  assert.deepStrictEqual(mdChunks.map((c) => c.title), ['Contrato', 'Contrato > Prazo', 'Contrato > Multa']);
  assert.ok(mdChunks[1].text.includes('12 meses'));
  assert.strictEqual(mdChunks[1].start, 4);

  const fence = '# T\n```\n# not a heading\n```\ntexto\n';
  assert.strictEqual(chunkDocument(fence, 'b.md').length, 1, 'headings inside code fences are ignored');

  const js = [
    '// soma dois números', 'function sum(a, b) {', '  return a + b;', '}', '',
    '/** multiplica */', 'export const mul = (a, b) => {', '  return a * b;', '};', '',
    'class Calc {', '  div(a, b) { return a / b; }', '}',
  ].join('\n');
  const jsChunks = chunkDocument(js, 'm.js', { maxChars: 60, overlapChars: 10 });
  const titles = jsChunks.map((c) => c.title);
  assert.ok(titles.some((t) => t.startsWith('function sum')));
  assert.ok(titles.some((t) => t.startsWith('export const mul')));
  assert.ok(titles.some((t) => t.startsWith('class Calc')));
  const sumChunk = jsChunks.find((c) => c.title.startsWith('function sum'));
  assert.ok(sumChunk.text.startsWith('// soma dois números'), 'comment above a declaration stays with it');
  const mulChunk = jsChunks.find((c) => c.title.startsWith('export const mul'));
  assert.ok(mulChunk.text.startsWith('/** multiplica */'));
});

test('splitArgs handles quotes', () => {
  assert.deepStrictEqual(splitArgs('-c 8192 --foo "a b"'), ['-c', '8192', '--foo', 'a b']);
  assert.deepStrictEqual(splitArgs(''), []);
});

test('client: OpenAI embeddings, legacy endpoint, pooling "none" fallback (mean-pooled), streaming', async () => {
  const a = await startMock();
  assert.strictEqual((await embed(a.url, ['hello', 'world'])).length, 2);
  let text = '';
  const full = await chatStream(a.url, [{ role: 'user', content: 'hi' }], { onDelta: (d) => (text += d) });
  assert.strictEqual(full, 'Resposta [1]');
  assert.strictEqual(text, full);
  a.server.close();

  const b = await startMock({ legacy: true });
  const out = await embed(b.url, ['hello']);
  assert.strictEqual(out[0].length, 64);
  b.server.close();

  // The exact error the user hit: 400 "Pooling type 'none' is not OAI compatible"
  const c = await startMock({ poolingError: true });
  const pooled = await embed(c.url, ['hello', 'world']);
  assert.deepStrictEqual(pooled, [[2, 3], [2, 3]], 'token vectors are averaged into one vector');
  c.server.close();
});

test('BrainDB: hybrid search (vector + FTS5, accent-insensitive), dimension guard, persistence', async () => {
  const dir = tmpdir();
  const file = path.join(dir, 'brain.sqlite');
  const db = new BrainDB(file);
  const docs = {
    '/a/contrato.md': ['O prazo do contrato é de doze meses', 'A multa por atraso é de dez por cento'],
    '/a/reuniao.md': ['Reunião de planejamento na terça com o time de pagamentos'],
    '/a/codigo.js': ['function loginUser(token) { return verifyJwt(token); }'],
  };
  for (const [p, texts] of Object.entries(docs)) {
    db.addFile({
      path: p, hash: p, mtime: 1, size: 1, kind: p.endsWith('.js') ? 'brain' : 'doc',
      chunks: texts.map((t, i) => ({ start: i + 1, end: i + 1, title: null, text: t })),
      vectors: texts.map((t) => fakeEmbed(t)),
    });
  }
  assert.deepStrictEqual(
    { files: db.stats().files, chunks: db.stats().chunks, dim: db.stats().dim },
    { files: 3, chunks: 4, dim: 64 },
  );

  // semantic-ish (vector) match
  let hits = db.search({ queryVec: fakeEmbed('qual o prazo do contrato'), queryText: 'qual o prazo do contrato', limit: 2 });
  assert.ok(hits[0].path.endsWith('contrato.md') && hits[0].text.includes('prazo'));
  // keyword-only, accents ignored: "reuniao" finds "Reunião"
  hits = db.search({ queryVec: null, queryText: 'reuniao', limit: 3 });
  assert.strictEqual(hits.length, 1);
  assert.ok(hits[0].path.endsWith('reuniao.md'));
  // identifier lookup through FTS prefix match
  hits = db.search({ queryVec: null, queryText: 'verifyJwt', limit: 3 });
  assert.ok(hits[0].path.endsWith('codigo.js') && hits[0].kind === 'brain');

  assert.throws(() => db.addFile({ path: '/b', hash: 'x', chunks: [{ start: 1, end: 1, text: 't' }], vectors: [[1, 2, 3]] }), /dimens/i);
  assert.throws(() => db.search({ queryVec: [1, 2, 3], queryText: 'x' }), /dimens/i);

  db.removeFile('/a/reuniao.md');
  assert.strictEqual(db.search({ queryVec: null, queryText: 'reuniao' }).length, 0, 'FTS entry removed with the file');

  db.close();
  const re = new BrainDB(file); // persistence round-trip
  assert.strictEqual(re.stats().chunks, 3);
  assert.ok(re.search({ queryVec: fakeEmbed('multa atraso'), queryText: 'multa atraso', limit: 1 })[0].text.includes('multa'));
  re.clear();
  assert.strictEqual(re.stats().chunks, 0);
  assert.strictEqual(re.stats().dim, 0, 'dim reset so a new embedding model can be used');
  re.close();
});

test('BrainDB memories: add, dedupe, accent-insensitive find, delete, survive clear()', () => {
  const db = new BrainDB(':memory:');
  const m1 = db.addMemory('Meu nome é Natan');
  assert.ok(db.addMemory('meu nome é natan').duplicate);
  db.addMemory('Prefiro respostas curtas');
  assert.strictEqual(db.listMemories().length, 2);
  assert.strictEqual(db.findMemories('NOME E natan').length, 1, 'case and accents ignored');
  assert.strictEqual(db.findMemories('natan nome').length, 0, 'substring match only, no fuzzy');
  assert.strictEqual(db.findMemories('nome é').length, 1);
  assert.strictEqual(db.searchMemories('respostas', 5).length, 1);
  db.clear(); // document index only
  assert.strictEqual(db.listMemories().length, 2);
  assert.ok(db.deleteMemory(m1.id));
  assert.strictEqual(db.listMemories().length, 1);
  db.clearMemories();
  assert.strictEqual(db.stats().memories, 0);
  db.close();
});

test('embed: a stopped server gives a clear message (en, pt, es)', async () => {
  const { embed } = require('../src/core/client');
  const I18N = require('../src/shared/i18n');
  try {
    I18N.setLang('en');
    await assert.rejects(() => embed('http://127.0.0.1:1', ['x']), /Could not connect to 127\.0\.0\.1:1.*Start/s);
    I18N.setLang('pt');
    await assert.rejects(() => embed('http://127.0.0.1:1', ['x']), /Não consegui conectar em 127\.0\.0\.1:1.*Iniciar/s);
    I18N.setLang('es');
    await assert.rejects(() => embed('http://127.0.0.1:1', ['x']), /No pude conectar con 127\.0\.0\.1:1.*Iniciar/s);
  } finally {
    I18N.setLang('en');
  }
});

test('llamafile: processo que morre ao iniciar falha na hora, com o fim do log', { skip: process.platform === 'win32' && 'usa scripts /bin/sh' }, async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { LlamafileServer } = require('../src/core/llamafile');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfb-srv-'));
  const bad = path.join(dir, 'bad.llamafile');
  fs.writeFileSync(bad, '#!/bin/sh\necho "error: modelo corrompido" >&2\nexit 3\n');
  const srv = new LlamafileServer({ name: 'embed' });
  const t0 = Date.now();
  await assert.rejects(() => srv.start({ file: bad, port: 18999 }), /closed while starting \(code 3\).*modelo corrompido/s);
  assert.ok(Date.now() - t0 < 10000, 'não espera o timeout de 5 min');
  assert.strictEqual(srv.status, 'error');
});

test('llamafile: porta ocupada gera erro claro e stop() encerra o processo filho', { skip: process.platform === 'win32' && 'usa scripts /bin/sh' }, async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const net = require('node:net');
  const path = require('node:path');
  const { LlamafileServer } = require('../src/core/llamafile');
  const holder = net.createServer();
  await new Promise((r) => holder.listen(18998, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfb-srv-'));
  const f = path.join(dir, 'x.llamafile');
  fs.writeFileSync(f, '#!/bin/sh\nsleep 30\n');
  const srv = new LlamafileServer({ name: 'chat' });
  await assert.rejects(() => srv.start({ file: f, port: 18998 }), /Port 18998 is already in use/);
  holder.close();
});

test('llamafile: start() chamado de novo enquanto inicia espera o mesmo processo', { skip: process.platform === 'win32' && 'usa scripts /bin/sh' }, async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { LlamafileServer } = require('../src/core/llamafile');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfb-srv-'));
  const bad = path.join(dir, 'slow.llamafile');
  fs.writeFileSync(bad, '#!/bin/sh\nsleep 1\necho falhou >&2\nexit 2\n');
  const srv = new LlamafileServer({ name: 'chat' });
  const a = srv.start({ file: bad, port: 18997 });
  const b = srv.start({ file: bad, port: 18997 });
  assert.strictEqual(a, b, 'mesma promessa');
  await assert.rejects(() => a, /closed while starting/);
});

test('llamafile: opção de GPU (auto / usar / só CPU) vira -ngl, sem sobrescrever argumentos do usuário', { skip: process.platform === 'win32' && 'usa scripts /bin/sh' }, async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { gpuFlags, splitArgs, LlamafileServer } = require('../src/core/llamafile');
  assert.deepStrictEqual(gpuFlags('auto', []), []);
  assert.deepStrictEqual(gpuFlags(undefined, []), []);
  assert.deepStrictEqual(gpuFlags('on', []), ['-ngl', '999']);
  assert.deepStrictEqual(gpuFlags('off', []), ['-ngl', '0']);
  assert.deepStrictEqual(gpuFlags('on', splitArgs('-c 4096 -ngl 20')), [], 'argumento manual vence');
  // o comando realmente executado inclui a flag
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfb-gpu-'));
  const f = path.join(dir, 'x.llamafile');
  fs.writeFileSync(f, '#!/bin/sh\nexit 1\n');
  const logs = [];
  const srv = new LlamafileServer({ name: 'chat', onLog: (_s, t) => logs.push(t) });
  await srv.start({ file: f, port: 18996, gpu: 'off' }).catch(() => {});
  assert.match(logs.join(''), /--port 18996 -ngl 0/);
});
