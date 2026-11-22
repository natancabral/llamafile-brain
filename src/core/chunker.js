'use strict';

const path = require('node:path');

/**
 * Generic line-based chunks with overlap. Keeps start/end line numbers (1-based).
 * `lineOffset` lets callers chunk a slice of a bigger file and still get absolute line numbers.
 */
function chunkText(text, { maxChars = 1200, overlapChars = 150, lineOffset = 0 } = {}) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const chunks = [];
  let buf = [];
  let size = 0;
  let startLine = 1;

  const flush = (endLine) => {
    const body = buf.join('\n').trim();
    if (body) chunks.push({ start: startLine + lineOffset, end: endLine + lineOffset, text: body });
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    while (line.length > maxChars) {
      // hard-split very long single lines (minified files, etc.)
      if (buf.length) {
        flush(i);
        buf = [];
        size = 0;
      }
      chunks.push({ start: i + 1 + lineOffset, end: i + 1 + lineOffset, text: line.slice(0, maxChars) });
      line = line.slice(maxChars);
      startLine = i + 1;
    }

    if (size + line.length + 1 > maxChars && buf.length) {
      flush(i); // lines startLine..i
      const keep = [];
      let keptSize = 0;
      for (let j = buf.length - 1; j >= 0 && keptSize < overlapChars; j--) {
        keep.unshift(buf[j]);
        keptSize += buf[j].length + 1;
      }
      startLine = i - keep.length + 1; // kept lines end at 1-based line i
      buf = keep;
      size = keptSize;
    }
    if (buf.length === 0) startLine = i + 1;
    buf.push(line);
    size += line.length + 1;
  }
  if (buf.length) flush(lines.length);
  return chunks;
}

// ------------------------------------------------------------------ structure-aware chunking

const MD_EXT = new Set(['.md', '.markdown']);

const CODE_BOUNDARY = {
  js: /^(export\s+)?(default\s+)?(async\s+)?(function\b|class\b|interface\b|type\s+\w+\s*[=<]|enum\b)|^(export\s+)?(const|let|var)\s+\w+\s*(:[^=]+)?=\s*(async\s*)?(\(|function\b|[\w$]+\s*=>)|^module\.exports\b|^exports\.\w+\s*=/,
  py: /^(async\s+def|def|class)\s+\w+|^@\w+/,
  sql: /^\s*(create|alter|drop|insert|with|select|update|delete)\b/i,
  generic: /^\s{0,4}((public|private|protected|internal|static|abstract|final|open|override|suspend|export)\s+)*(func|fn|pub|def|class|interface|struct|impl|trait|enum|module|object|namespace|void|int|string|async|function)\b/,
};
const CODE_KIND = {
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.tsx': 'js', '.vue': 'js', '.svelte': 'js',
  '.py': 'py', '.sql': 'sql', '.prisma': 'generic', '.graphql': 'generic', '.proto': 'generic',
  '.java': 'generic', '.kt': 'generic', '.cs': 'generic', '.go': 'generic', '.rs': 'generic', '.rb': 'generic',
  '.php': 'generic', '.c': 'generic', '.h': 'generic', '.cpp': 'generic', '.hpp': 'generic',
};
const COMMENT_START = /^\s*(\/\/|#|\*|\/\*|@|--)/;

/** Merges consecutive [start,end) line segments into chunks <= maxChars; oversized segments are split. */
function packSegments(lines, segs, { maxChars, overlapChars, mergeBelow = Infinity }) {
  const out = [];
  let cur = null;
  const emit = () => {
    if (!cur) return;
    const text = lines.slice(cur.s, cur.e).join('\n').trim();
    if (text) out.push({ start: cur.s + 1, end: cur.e, title: cur.title, text });
    cur = null;
  };
  for (const seg of segs) {
    const segText = lines.slice(seg.s, seg.e).join('\n');
    if (segText.length > maxChars) {
      emit();
      const parts = chunkText(segText, { maxChars, overlapChars, lineOffset: seg.s });
      parts.forEach((p) => out.push({ ...p, title: seg.title }));
      continue;
    }
    const curLen = cur ? lines.slice(cur.s, cur.e).join('\n').length : 0;
    if (cur && curLen < mergeBelow && curLen + segText.length + 1 <= maxChars) {
      cur.e = seg.e;
    } else {
      emit();
      cur = { s: seg.s, e: seg.e, title: seg.title };
    }
  }
  emit();
  return out;
}

/** Markdown: one segment per heading section, with the heading path ("A > B") as title.
 *  Sections shorter than `minChars` are merged with the next one so tiny headings don't become tiny chunks. */
function chunkMarkdown(text, opts) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const stack = []; // [{level, title}]
  const segs = [];
  let segStart = 0;
  let segTitle = '';
  let inFence = false;
  const close = (end) => {
    if (end > segStart) segs.push({ s: segStart, e: end, title: segTitle });
  };
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (m) {
      close(i);
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: m[2] });
      segTitle = stack.map((h) => h.title).join(' > ');
      segStart = i;
    }
  });
  close(lines.length);
  return packSegments(lines, segs, { ...opts, mergeBelow: opts.minChars ?? 200 });
}

/** Code: split before top-level declarations (functions, classes, SQL statements...). */
function chunkCode(text, kind, opts) {
  const re = CODE_BOUNDARY[kind];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    if (re.test(line)) starts.push(i);
  });
  if (starts.length < 2) return chunkText(text, opts);

  // include the comment/decorator lines directly above a declaration
  const adj = starts.map((s, idx) => {
    let b = s;
    const floor = idx ? starts[idx - 1] + 1 : 0;
    while (b - 1 >= floor && lines[b - 1].trim() && COMMENT_START.test(lines[b - 1])) b--;
    return b;
  });
  const segs = [];
  if (adj[0] > 0) segs.push({ s: 0, e: adj[0], title: '' });
  adj.forEach((b, idx) => {
    const e = idx + 1 < adj.length ? adj[idx + 1] : lines.length;
    const sig = lines[starts[idx]].trim().replace(/\s+/g, ' ').slice(0, 90);
    segs.push({ s: b, e, title: sig });
  });
  return packSegments(lines, segs, opts);
}

/** Chooses the strategy by file type. Returns [{start,end,title?,text}]. */
function chunkDocument(text, file, { maxChars = 1200, overlapChars = 150, minChars = 200 } = {}) {
  const opts = { maxChars, overlapChars, minChars };
  const ext = path.extname(file || '').toLowerCase();
  if (MD_EXT.has(ext)) return chunkMarkdown(text, opts);
  if (CODE_KIND[ext]) return chunkCode(text, CODE_KIND[ext], opts);
  return chunkText(text, opts);
}

module.exports = { chunkText, chunkDocument, chunkMarkdown, chunkCode };
