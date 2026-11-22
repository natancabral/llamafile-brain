'use strict';

// Formatos de documento: usa arquivos reais gerados pelo LibreOffice (pula se não estiver instalado).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { extractText } = require('../src/core/indexer');

const hasLO = spawnSync('soffice', ['--version']).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfb-fmt-'));
fs.writeFileSync(path.join(dir, 'vendas.csv'), 'Produto,Preco,Estoque\nParafuso,1.50,200\nMartelo,35,12\n');
fs.writeFileSync(path.join(dir, 'contrato.txt'), 'Contrato de locacao\nO prazo e de doze meses.\n');
if (hasLO) {
  for (const [fmt, src] of [['xlsx', 'vendas.csv'], ['xls', 'vendas.csv'], ['ods', 'vendas.csv'], ['doc', 'contrato.txt'], ['docx', 'contrato.txt'], ['rtf', 'contrato.txt']]) {
    execFileSync('soffice', ['--headless', '--convert-to', fmt, '--outdir', dir, path.join(dir, src)], { stdio: 'ignore', timeout: 120000 });
  }
}
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

for (const ext of ['xlsx', 'ods', 'xls']) {
  test(`.${ext} vira linhas "A | B | C" por planilha`, async (t) => {
    if (!hasLO) return t.skip('LibreOffice ausente');
    const text = await extractText(path.join(dir, `vendas.${ext}`), {});
    assert.match(text, /## Planilha/);
    assert.match(text, /Produto \| Preco \| Estoque/);
    assert.match(text, /Martelo \| 35 \| 12/);
  });
}
for (const ext of ['docx', 'doc', 'rtf']) {
  test(`.${ext} extrai o texto`, async (t) => {
    if (!hasLO) return t.skip('LibreOffice ausente');
    assert.match(await extractText(path.join(dir, `contrato.${ext}`), {}), /prazo e de doze meses/);
  });
}
test('.pptx (zip mínimo) extrai o texto por slide', async () => {
  const { zipSync, strToU8 } = require('fflate');
  const slide = (t) => strToU8(`<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`);
  fs.writeFileSync(path.join(dir, 'a.pptx'), zipSync({ 'ppt/slides/slide1.xml': slide('Meta de vendas'), 'ppt/slides/slide2.xml': slide('Plano 2027') }));
  const text = await extractText(path.join(dir, 'a.pptx'), {});
  assert.match(text, /## Slide 1\nMeta de vendas/);
  assert.match(text, /## Slide 2\nPlano 2027/);
});
test('.sql e .json são texto puro', async () => {
  fs.writeFileSync(path.join(dir, 'a.sql'), 'CREATE TABLE clientes (id INT);');
  fs.writeFileSync(path.join(dir, 'a.json'), '{"nome":"Natan"}');
  assert.match(await extractText(path.join(dir, 'a.sql'), {}), /CREATE TABLE clientes/);
  assert.match(await extractText(path.join(dir, 'a.json'), {}), /Natan/);
});
