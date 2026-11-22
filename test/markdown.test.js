'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseBlocks, parseInline, renderMarkdown } = require('../src/renderer/markdown');

test('markdown: inline formatting', () => {
  const n = parseInline('**negrito** e *itálico* com `code`, snake_case_name, ~~x~~, [site](https://a.com) e https://b.org/p.');
  const types = n.map((x) => x.t);
  assert.ok(types.includes('strong') && types.includes('em') && types.includes('code') && types.includes('del'));
  assert.deepStrictEqual(n.filter((x) => x.t === 'link').map((x) => x.href), ['https://a.com', 'https://b.org/p']);
  assert.ok(n.some((x) => x.t === 'text' && x.v.includes('snake_case_name')), 'underscores inside words are not italics');
  assert.deepStrictEqual(parseInline('2 * 3 * 4'), [{ t: 'text', v: '2 * 3 * 4' }], 'spaced asterisks stay literal');
});

test('markdown: blocks (headings, nested lists, ordered, fences, quotes, tables, hr)', () => {
  const md = '## Título\n\nParágrafo **bold**.\nSegunda linha.\n\n- item 1\n- item 2\n  - sub a\n  - sub b\n\n3. três\n4. quatro\n\n```js\nconst a = 1;\n```\n\n> citação\n\n| a | b |\n|---|:-:|\n| 1 | **2** |\n\n---\nfim';
  const b = parseBlocks(md);
  assert.deepStrictEqual(b.map((x) => x.t), ['h', 'p', 'list', 'list', 'code', 'quote', 'table', 'hr', 'p']);
  assert.strictEqual(b[2].items.length, 2);
  assert.strictEqual(b[2].items[1][1].t, 'list', 'nested list inside item 2');
  assert.strictEqual(b[3].ordered, true);
  assert.strictEqual(b[3].start, 3);
  assert.deepStrictEqual({ lang: b[4].lang, v: b[4].v }, { lang: 'js', v: 'const a = 1;' });
  assert.deepStrictEqual(b[6].align, ['', 'center']);
  assert.strictEqual(b[6].rows[0][1][0].t, 'strong');
});

test('markdown: streaming-safe (unclosed fence / half-written bold do not throw)', () => {
  assert.deepStrictEqual(parseBlocks('```py\nprint(1)').map((x) => x.t), ['code']);
  assert.doesNotThrow(() => parseBlocks('Texto **negrito sem fechar e `code'));
  assert.doesNotThrow(() => parseBlocks('| a | b |\n|---'));
  assert.doesNotThrow(() => parseBlocks(''));
});

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  /* optional dev-only dependency */
}

test('markdown DOM: renders elements and never injects HTML/scripts (needs jsdom)', (t) => {
  if (!JSDOM) return t.skip('jsdom not installed (npm i --no-save jsdom to run this check)');
  const { document } = new JSDOM('<!doctype html><div id="r"></div>').window;
  const root = document.getElementById('r');
  renderMarkdown(
    root,
    [
      '# Título', '', 'Olá **mundo** `x < y`', '',
      '<script>alert(1)</script>', '<img src=x onerror="alert(2)">', '',
      '[ok](https://example.com) [mau](javascript:alert(3)) [dados](data:text/html,<b>x</b>)', '',
      '- a', '- b', '', '```html', '<b onclick="x()">não é html</b>', '```', '',
      '| h1 | h2 |', '|---|---|', '| <i>x</i> | y |',
    ].join('\n'),
    document,
  );
  assert.strictEqual(root.querySelectorAll('script, img, iframe, object, embed').length, 0, 'no dangerous elements');
  assert.ok(![...root.querySelectorAll('*')].some((e) => [...e.attributes].some((a) => /^on/i.test(a.name))), 'no event-handler attributes');
  assert.ok(root.textContent.includes('<script>alert(1)</script>'), 'raw HTML shows up as text');
  assert.ok(root.querySelector('code').textContent.includes('x < y'));
  const links = [...root.querySelectorAll('a')];
  assert.deepStrictEqual(links.map((a) => a.getAttribute('href')), ['https://example.com'], 'javascript:/data: links become plain text');
  assert.strictEqual(links[0].getAttribute('rel'), 'noopener noreferrer');
  assert.strictEqual(links[0].getAttribute('target'), '_blank');
  assert.strictEqual(root.querySelectorAll('h2').length, 1);
  assert.strictEqual(root.querySelectorAll('strong').length, 1);
  assert.strictEqual(root.querySelectorAll('li').length, 2);
  assert.strictEqual(root.querySelectorAll('.codeblock pre code').length, 1);
  assert.ok(root.querySelector('.codeblock code').textContent.includes('<b onclick'));
  assert.strictEqual(root.querySelectorAll('table th').length, 2);
  assert.ok(root.querySelector('table td').textContent === '<i>x</i>', 'table cell HTML is text');

  // re-rendering replaces the previous content (used while streaming)
  renderMarkdown(root, 'só texto', document);
  assert.strictEqual(root.children.length, 1);
  assert.strictEqual(root.firstElementChild.tagName, 'P');
});
