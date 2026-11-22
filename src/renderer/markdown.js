'use strict';
// Label lookup: uses the i18n catalog when loaded (renderer), plain English otherwise (tests/Node).
const L = (k) => (typeof I18N !== 'undefined' ? I18N.t('md.' + k) : { copy: 'Copy', copied: 'Copied!' }[k]);

/**
 * Small, safe Markdown renderer (no innerHTML, no external deps).
 * parseBlocks()/parseInline() are pure (testable in Node); renderMarkdown() builds DOM nodes with
 * createElement/textContent only, so model output can never inject HTML or scripts.
 * Supports: headings, paragraphs, **bold**, *italic*, ~~strike~~, `code`, fenced code blocks,
 * ordered/unordered (nested) lists, blockquotes, tables, horizontal rules, links (http/https/mailto).
 */

// ------------------------------------------------------------------ inline
function parseInline(s) {
  const out = [];
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  while (i < s.length) {
    const c = s[i];

    if (c === '\\' && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }

    if (c === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      const end = s.indexOf(fence, i + n);
      if (end > i + n - 1 && end !== -1) {
        flush();
        out.push({ t: 'code', v: s.slice(i + n, end).trim() });
        i = end + n;
        continue;
      }
    }

    if (c === '*' || c === '_' || c === '~') {
      const dbl = s[i + 1] === c;
      if (c === '~' && !dbl) {
        buf += c;
        i++;
        continue;
      }
      if (dbl) {
        const end = s.indexOf(c + c, i + 2);
        if (end > i + 2 && !/\s/.test(s[i + 2]) && !/\s/.test(s[end - 1])) {
          flush();
          out.push({ t: c === '~' ? 'del' : 'strong', c: parseInline(s.slice(i + 2, end)) });
          i = end + 2;
          continue;
        }
      } else if (!(c === '_' && i > 0 && /\w/.test(s[i - 1])) && s[i + 1] !== undefined && !/\s/.test(s[i + 1])) {
        let j = i + 1;
        while (j < s.length) {
          if (s[j] === c && s[j - 1] !== '\\' && !/\s/.test(s[j - 1]) && s[j + 1] !== c) break;
          j++;
        }
        if (j < s.length && j > i + 1 && !(c === '_' && /\w/.test(s[j + 1] || ''))) {
          flush();
          out.push({ t: 'em', c: parseInline(s.slice(i + 1, j)) });
          i = j + 1;
          continue;
        }
      }
    }

    if (c === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(s.slice(i));
      if (m) {
        flush();
        out.push({ t: 'link', href: m[2], c: parseInline(m[1]) });
        i += m[0].length;
        continue;
      }
    }

    if (c === 'h' && (s.startsWith('http://', i) || s.startsWith('https://', i))) {
      const m = /^https?:\/\/[^\s<>)\]]*[^\s<>)\].,;:!?'"]/.exec(s.slice(i));
      if (m) {
        flush();
        out.push({ t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] });
        i += m[0].length;
        continue;
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

// ------------------------------------------------------------------ blocks
const FENCE_RE = /^\s*(```|~~~)\s*([\w+#.-]*)/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s*>/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isSep = (l) => l.includes('|') && TABLE_SEP_RE.test(l);

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const indentOf = (l) => l.length - l.trimStart().length;

function startsBlock(lines, i) {
  const l = lines[i];
  return (
    FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || LIST_RE.test(l) ||
    (l.includes('|') && i + 1 < lines.length && isSep(lines[i + 1]))
  );
}

function parseLines(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    let m = FENCE_RE.exec(line);
    if (m) {
      const fence = m[1];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
      i++; // closing fence (or end of text while streaming)
      out.push({ t: 'code', lang: m[2], v: body.join('\n') });
      continue;
    }

    m = HEADING_RE.exec(line);
    if (m) {
      out.push({ t: 'h', level: m[1].length, c: parseInline(m[2]) });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const q = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push({ t: 'quote', c: parseLines(q) });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : /^:-/.test(c) ? 'left' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      out.push({
        t: 'table', align,
        head: head.map((c) => parseInline(c)),
        rows: rows.map((r) => r.map((c) => parseInline(c))),
      });
      continue;
    }

    const lm = LIST_RE.exec(line);
    if (lm) {
      const base = lm[1].length;
      const ordered = /\d/.test(lm[2]);
      const start = ordered ? parseInt(lm[2], 10) : 1;
      const items = [];
      while (i < lines.length) {
        let l = lines[i];
        if (!l.trim()) {
          // blank line: keep the list going only if the next non-blank line is another item of this list
          let k = i + 1;
          while (k < lines.length && !lines[k].trim()) k++;
          const nm = k < lines.length ? LIST_RE.exec(lines[k]) : null;
          if (nm && nm[1].length >= base && /\d/.test(nm[2]) === ordered) {
            i = k;
            l = lines[i];
          } else break;
        }
        const im = LIST_RE.exec(l);
        if (!im || im[1].length !== base || /\d/.test(im[2]) !== ordered) break;
        const itemLines = [im[3]];
        i++;
        while (i < lines.length) {
          const nxt = lines[i];
          if (!nxt.trim()) break;
          const nm = LIST_RE.exec(nxt);
          if (indentOf(nxt) > base) itemLines.push(nxt.slice(Math.min(indentOf(nxt), base + 2)));
          else if (nm && nm[1].length <= base) break;
          else if (startsBlock(lines, i)) break;
          else itemLines.push(nxt.trim()); // lazy continuation
          i++;
        }
        const blocks = parseLines(itemLines);
        items.push(blocks.length === 1 && blocks[0].t === 'p' ? [{ t: 'p', c: blocks[0].c, tight: true }] : blocks);
      }
      out.push({ t: 'list', ordered, start, items });
      continue;
    }

    // paragraph
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++]);
    out.push({ t: 'p', c: parseInline(para.map((l) => l.trim()).join('\n')) });
  }
  return out;
}

function parseBlocks(src) {
  return parseLines(String(src).replace(/\r\n/g, '\n').split('\n'));
}

// ------------------------------------------------------------------ DOM
const SAFE_URL = /^(https?:|mailto:)/i;

function inlineNodes(nodes, doc) {
  const frag = doc.createDocumentFragment();
  for (const n of nodes) {
    switch (n.t) {
      case 'text': {
        n.v.split('\n').forEach((part, idx) => {
          if (idx) frag.append(doc.createElement('br'));
          if (part) frag.append(doc.createTextNode(part));
        });
        break;
      }
      case 'code': {
        const el = doc.createElement('code');
        el.className = 'inline';
        el.textContent = n.v;
        frag.append(el);
        break;
      }
      case 'strong':
      case 'em':
      case 'del': {
        const el = doc.createElement(n.t === 'del' ? 's' : n.t);
        el.append(inlineNodes(n.c, doc));
        frag.append(el);
        break;
      }
      case 'link': {
        if (SAFE_URL.test(n.href)) {
          const a = doc.createElement('a');
          a.setAttribute('href', n.href);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          a.append(inlineNodes(n.c, doc));
          frag.append(a);
        } else {
          frag.append(inlineNodes(n.c, doc)); // unsafe scheme (javascript:, data:...) -> plain text
        }
        break;
      }
      default:
        break;
    }
  }
  return frag;
}

function blockNode(b, doc) {
  switch (b.t) {
    case 'h': {
      const el = doc.createElement(`h${Math.min(6, b.level + 1)}`); // # becomes h2: chat-sized headings
      el.append(inlineNodes(b.c, doc));
      return el;
    }
    case 'p': {
      const el = doc.createElement(b.tight ? 'span' : 'p');
      el.append(inlineNodes(b.c, doc));
      return el;
    }
    case 'hr':
      return doc.createElement('hr');
    case 'quote': {
      const el = doc.createElement('blockquote');
      b.c.forEach((x) => el.append(blockNode(x, doc)));
      return el;
    }
    case 'code': {
      const wrap = doc.createElement('div');
      wrap.className = 'codeblock';
      const bar = doc.createElement('div');
      bar.className = 'codebar';
      const lang = doc.createElement('span');
      lang.textContent = b.lang || 'texto';
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'copy';
      btn.textContent = L('copy');
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(b.v);
          btn.textContent = L('copied');
        } catch {
          btn.textContent = 'Falhou';
        }
        setTimeout(() => (btn.textContent = L('copy')), 1500);
      });
      bar.append(lang, btn);
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = b.v;
      pre.append(code);
      wrap.append(bar, pre);
      return wrap;
    }
    case 'list': {
      const el = doc.createElement(b.ordered ? 'ol' : 'ul');
      if (b.ordered && b.start !== 1) el.setAttribute('start', String(b.start));
      for (const item of b.items) {
        const li = doc.createElement('li');
        item.forEach((x) => li.append(blockNode(x, doc)));
        el.append(li);
      }
      return el;
    }
    case 'table': {
      const wrap = doc.createElement('div');
      wrap.className = 'tablewrap';
      const table = doc.createElement('table');
      const thead = doc.createElement('thead');
      const tr = doc.createElement('tr');
      b.head.forEach((c, i) => {
        const th = doc.createElement('th');
        if (b.align[i]) th.style.textAlign = b.align[i];
        th.append(inlineNodes(c, doc));
        tr.append(th);
      });
      thead.append(tr);
      const tbody = doc.createElement('tbody');
      for (const r of b.rows) {
        const row = doc.createElement('tr');
        b.head.forEach((_, i) => {
          const td = doc.createElement('td');
          if (b.align[i]) td.style.textAlign = b.align[i];
          td.append(inlineNodes(r[i] || [], doc));
          row.append(td);
        });
        tbody.append(row);
      }
      table.append(thead, tbody);
      wrap.append(table);
      return wrap;
    }
    default:
      return doc.createTextNode('');
  }
}

/** Replaces the content of `container` with the rendered Markdown. */
function renderMarkdown(container, text, doc = container.ownerDocument) {
  const frag = doc.createDocumentFragment();
  for (const b of parseBlocks(text)) frag.append(blockNode(b, doc));
  container.textContent = '';
  container.append(frag);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseBlocks, parseInline, renderMarkdown };
}
if (typeof window !== 'undefined') window.renderMarkdown = renderMarkdown;
