'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const I18N = require('../src/shared/i18n');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('i18n: every key has en, pt and es text, with the same placeholders', () => {
  for (const [key, entry] of Object.entries(I18N.catalog)) {
    assert.strictEqual(entry.length, 3, `${key}: needs [en, pt, es]`);
    entry.forEach((s, i) => assert.ok(typeof s === 'string' && s.length, `${key}[${I18N.ORDER[i]}] is empty`));
    assert.strictEqual(placeholders(entry[1]), placeholders(entry[0]), `${key}: pt placeholders differ`);
    assert.strictEqual(placeholders(entry[2]), placeholders(entry[0]), `${key}: es placeholders differ`);
  }
});

test('i18n: keys used in index.html and in the code exist in the catalog', () => {
  const used = new Set();
  const html = read('src', 'renderer', 'index.html');
  for (const m of html.matchAll(/data-i18n(?:-ph|-title)?="([\w.]+)"/g)) used.add(m[1]);
  for (const f of ['src/renderer/renderer.js', 'src/main.js', 'src/core/rag.js', 'src/core/memory.js', 'src/core/summarize.js', 'src/core/client.js', 'src/core/llamafile.js', 'src/core/indexer.js', 'src/core/db.js', 'src/core/rerank.js', 'src/core/sqlite.js', 'src/renderer/markdown.js']) {
    for (const m of read(...f.split('/')).matchAll(/\b(?:tr|t|L)\(\s*'([a-z]+\.[\w.]+)'/g)) used.add(m[1]);
  }
  for (const m of read('src', 'renderer', 'renderer.js').matchAll(/'((?:srv|ev|su|dep)\.[\w.]+)'/g)) used.add(m[1]);
  const missing = [...used].filter((k) => !I18N.catalog[k]);
  assert.deepStrictEqual(missing, []);
  assert.ok(used.size > 100);
});

test('i18n: t() formats params, falls back to English and to the key', () => {
  I18N.setLang('pt');
  assert.strictEqual(I18N.t('tab.servers'), 'Servidores');
  assert.strictEqual(I18N.t('kn.stats', { files: 1, chunks: 2, memories: 3 }), '1 arquivos · 2 trechos · 3 memórias');
  assert.strictEqual(I18N.t('tab.servers', null, 'es'), 'Servidores');
  assert.strictEqual(I18N.t('no.such.key'), 'no.such.key');
  assert.strictEqual(I18N.setLang('xx'), 'en', 'unknown language falls back to English');
  assert.strictEqual(I18N.t('tab.servers'), 'Servers');
  assert.strictEqual(I18N.detect('pt_BR.UTF-8'), 'pt');
  assert.strictEqual(I18N.detect('es-MX'), 'es');
  assert.strictEqual(I18N.detect('fr-FR'), 'en');
});

test('index.html has no hard-coded Portuguese left (visible text is English + data-i18n)', () => {
  const html = read('src', 'renderer', 'index.html');
  const stripped = html.replace(/<option value="pt">Português<\/option>/, '').replace(/<option value="es">Español<\/option>/, '');
  assert.ok(!/[áàâãéêíóôõúç]/i.test(stripped), 'accented characters found in index.html');
});
