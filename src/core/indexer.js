'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chunkDocument } = require('./chunker');
const { embed } = require('./client');
const { findBin } = require('./bins');
const { ocrStatus, ocrImage, ocrPdf, IMAGE_EXT } = require('./ocr');
const { t: tr } = require('../shared/i18n');

const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.rst', '.json', '.yml', '.yaml', '.toml', '.xml', '.csv', '.sql',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.java', '.kt', '.cs', '.go', '.rs', '.rb',
  '.php', '.c', '.h', '.cpp', '.hpp', '.sh', '.html', '.css', '.scss', '.vue', '.svelte', '.prisma',
  '.graphql', '.proto', '.tf', '.dockerfile',
]);
const ZIP_DOC_EXT = new Set(['.odt', '.docx']);
const SHEET_EXT = new Set(['.xlsx', '.xlsm', '.ods']);
const SLIDE_EXT = new Set(['.pptx', '.odp']);
const LEGACY_EXT = { '.doc': 'docx', '.rtf': 'docx', '.xls': 'xlsx', '.ppt': 'pptx' }; // via LibreOffice, if installed
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', '.venv', 'venv',
  '__pycache__', 'target', '.idea', '.vscode', '.cache', 'vendor',
]);
// Never index likely secrets.
const SECRET_RE = /(^\.env(\..*)?$)|(\.(pem|key|p12|pfx|jks|keystore)$)|(^id_(rsa|dsa|ecdsa|ed25519)$)|(secrets?\.(json|ya?ml)$)|(credentials)/i;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_BIG_BYTES = 20 * 1024 * 1024; // pdf / images
// Huge files are read as a stream and stored keyword-only (FTS5, no embeddings): constant RAM, minutes instead of hours.
const MAX_STREAM_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB
const SQLITE_EXT = new Set(['.sqlite', '.sqlite3', '.db', '.db3']);
// A SQLite database that yields at most this many chunks also gets embeddings (semantic search over its rows); bigger ones stay keyword-only.
const SQLITE_EMBED_MAX = 2000;
const STREAM_CHUNK_CHARS = 1200;
const STREAM_VERSION = 'v2'; // bump when the streaming readers change what they capture, so those files are re-read once
const STREAM_BLOCK = 500; // chunks written per transaction
const GENERATED_NOTES = ['memory.md', 'memoria.md']; // legacy name kept // exported by the app into the brain folder; not re-indexed

/** Matches user ignore patterns: "*.png", "prontuario", "pasta/sub", "arquivo.txt". */
function makeIgnore(patterns = []) {
  const pats = patterns.map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  return (full, root) => {
    if (!pats.length) return false;
    const rel = path.relative(root, full).split(path.sep).join('/').toLowerCase();
    const segs = rel.split('/');
    return pats.some((p) => {
      if (p.startsWith('*.')) return rel.endsWith(p.slice(1));
      if (p.includes('/')) return rel === p || rel.startsWith(p + '/') || rel.includes('/' + p + '/');
      return segs.includes(p);
    });
  };
}

function* walk(dir, root, ignored) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // never follow symlinks out of the allowed folder
    const full = path.join(dir, e.name);
    if (ignored(full, root)) continue;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full, root, ignored);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Extracts plain text from .odt / .docx (zip + XML). */
function extractZipDoc(file, ext) {
  const { unzipSync, strFromU8 } = require('fflate');
  const inner = ext === '.odt' ? 'content.xml' : 'word/document.xml';
  const files = unzipSync(fs.readFileSync(file), { filter: (f) => f.name === inner });
  if (!files[inner]) return '';
  let xml = strFromU8(files[inner]);
  if (ext === '.odt') {
    xml = xml
      .replace(/<\/text:(p|h|list-item)>/g, '\n')
      .replace(/<text:tab\/>/g, '\t')
      .replace(/<text:line-break\/>/g, '\n')
      .replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_, n) => ' '.repeat(Number(n || 1)));
  } else {
    xml = xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n');
  }
  return decodeEntities(xml.replace(/<[^>]+>/g, ''));
}

function xmlText(xml) {
  return decodeEntities(xml.replace(/<[^>]+>/g, ''));
}

/** .xlsx / .ods -> text, one "## Planilha" section per sheet, cells separated by " | ". */
function extractSheet(file, ext) {
  const { unzipSync, strFromU8 } = require('fflate');
  const out = [];
  if (ext === '.ods') {
    const z = unzipSync(fs.readFileSync(file), { filter: (f) => f.name === 'content.xml' });
    if (!z['content.xml']) return '';
    const xml = strFromU8(z['content.xml']);
    for (const m of xml.matchAll(/<table:table [^>]*?table:name="([^"]*)"[^>]*>([\s\S]*?)<\/table:table>/g)) {
      const rows = [];
      for (const r of m[2].matchAll(/<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g)) {
        const cells = [...r[1].matchAll(/<table:table-cell[^>]*?(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g)].map((c) =>
          xmlText((c[1] || '').replace(/<\/text:p>/g, ' ')).trim(),
        );
        while (cells.length && !cells[cells.length - 1]) cells.pop();
        if (cells.length) rows.push(cells.join(' | '));
      }
      if (rows.length) out.push(`## Planilha: ${decodeEntities(m[1])}\n${rows.join('\n')}`);
    }
    return out.join('\n\n');
  }
  const z = unzipSync(fs.readFileSync(file), {
    filter: (f) => f.name === 'xl/sharedStrings.xml' || f.name === 'xl/workbook.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name),
  });
  const shared = z['xl/sharedStrings.xml']
    ? [...strFromU8(z['xl/sharedStrings.xml']).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]))
    : [];
  const names = z['xl/workbook.xml'] ? [...strFromU8(z['xl/workbook.xml']).matchAll(/<sheet [^>]*?name="([^"]*)"/g)].map((m) => decodeEntities(m[1])) : [];
  const sheets = Object.keys(z).filter((n) => n.startsWith('xl/worksheets/')).sort((a, b) => parseInt(a.match(/(\d+)\.xml/)[1], 10) - parseInt(b.match(/(\d+)\.xml/)[1], 10));
  sheets.forEach((name, i) => {
    const rows = [];
    for (const r of strFromU8(z[name]).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const body = c[2] || '';
        const type = /t="(\w+)"/.exec(c[1])?.[1];
        let v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (type === 's') v = shared[Number(v)];
        else if (type === 'inlineStr') v = xmlText(body);
        else if (v !== undefined) v = decodeEntities(v);
        cells.push(v === undefined ? '' : String(v).trim());
      }
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.length) rows.push(cells.join(' | '));
    }
    if (rows.length) out.push(`## Planilha: ${names[i] || `Plan${i + 1}`}\n${rows.join('\n')}`);
  });
  return out.join('\n\n');
}

/** .pptx / .odp -> text per slide. */
function extractSlides(file, ext) {
  const { unzipSync, strFromU8 } = require('fflate');
  if (ext === '.odp') {
    const z = unzipSync(fs.readFileSync(file), { filter: (f) => f.name === 'content.xml' });
    if (!z['content.xml']) return '';
    return xmlText(strFromU8(z['content.xml']).replace(/<\/text:(p|h)>/g, '\n'));
  }
  // slides + speaker notes (notesSlideN.xml carries the same number as its slide)
  const z = unzipSync(fs.readFileSync(file), { filter: (f) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(f.name) });
  const num = (n) => parseInt(n.match(/(\d+)\.xml$/)[1], 10);
  const text = (n) => xmlText(strFromU8(z[n]).replace(/<\/a:p>/g, '\n')).trim();
  const notes = new Map(Object.keys(z).filter((n) => n.startsWith('ppt/notesSlides/')).map((n) => [num(n), text(n)]));
  return Object.keys(z)
    .filter((n) => n.startsWith('ppt/slides/'))
    .sort((a, b) => num(a) - num(b))
    .map((n, i) => {
      const note = notes.get(num(n));
      return `## Slide ${i + 1}\n${text(n)}${note ? `\n\nNotes: ${note}` : ''}`;
    })
    .join('\n\n');
}

/** Old binary formats (.doc .xls .ppt .rtf): convert with LibreOffice when it is installed. */
async function extractLegacy(file, ext, signal) {
  const { execFile } = require('node:child_process');
  const os = require('node:os');
  const target = LEGACY_EXT[ext];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lfb-lo-'));
  try {
    const bins = [findBin('soffice', 'libreoffice')].filter(Boolean);
    for (const b of bins) {
      const ok = await new Promise((resolve) => {
        execFile(b, ['--headless', '--convert-to', target, '--outdir', tmp, file], { timeout: 120000, signal }, (e) => resolve(!e));
      });
      if (!ok) continue;
      const out = path.join(tmp, `${path.basename(file, path.extname(file))}.${target}`);
      if (!fs.existsSync(out)) continue;
      return extractText(out, { signal });
    }
    return null; // LibreOffice not available
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const SQL_TITLE = /^\s*(create\s+(?:unique\s+)?(?:table|index|view|trigger)(?:\s+if\s+not\s+exists)?\s+[^\s(]+|insert\s+(?:or\s+\w+\s+)?into\s+[^\s(]+|alter\s+table\s+[^\s(]+|drop\s+\w+\s+[^\s;]+|update\s+[^\s(]+)/i;
const sleep0 = () => new Promise((r) => setImmediate(r));

/** Streams a .sql file line by line into ~1200-character chunks (never holds the file in memory). */
async function* sqlChunks(file, signal) {
  const rl = require('node:readline').createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let buf = [];
  let size = 0;
  let start = 1;
  let title = '';
  let n = 0;
  const take = (end) => {
    const text = buf.join('\n').trim();
    const out = text ? { start, end, title, text } : null;
    buf = [];
    size = 0;
    title = '';
    return out;
  };
  try {
    for await (const raw of rl) {
      if (signal?.aborted) return;
      n++;
      let line = raw;
      const isCreate = /^\s*create\s/i.test(line);
      if (isCreate && buf.length) {
        const c = take(n - 1);
        if (c) yield c;
      }
      while (line.length > STREAM_CHUNK_CHARS) {
        // a single enormous line (multi-row INSERT, minified dump): hard-split it
        if (buf.length) {
          const c = take(n - 1);
          if (c) yield c;
        }
        const m = SQL_TITLE.exec(line);
        yield { start: n, end: n, title: m ? m[1].replace(/\s+/g, ' ').slice(0, 90) : '', text: line.slice(0, STREAM_CHUNK_CHARS) };
        line = line.slice(STREAM_CHUNK_CHARS);
      }
      if (size + line.length + 1 > STREAM_CHUNK_CHARS && buf.length) {
        const c = take(n - 1);
        if (c) yield c;
      }
      if (!buf.length) start = n;
      if (!title) {
        const m = SQL_TITLE.exec(line);
        if (m) title = m[1].replace(/\s+/g, ' ').slice(0, 90);
      }
      buf.push(line);
      size += line.length + 1;
    }
    const c = take(n);
    if (c) yield c;
  } finally {
    rl.close();
  }
}

const qIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;
const fmtCell = (v) => {
  if (v == null) return 'NULL';
  if (v instanceof Uint8Array) return `<blob ${v.byteLength} bytes>`;
  const t = String(v).replace(/\s+/g, ' ');
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
};

function isSqliteFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(16);
      fs.readSync(fd, b, 0, 16, 0);
      return b.toString('latin1') === 'SQLite format 3\0';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Reads a SQLite database read-only: the schema first, then every table row by row, grouped into chunks. */
async function* sqliteChunks(file, signal) {
  if (!isSqliteFile(file)) throw new Error('not a SQLite database');
  const { DatabaseSync } = require('node:sqlite');
  const sdb = new DatabaseSync(file, { readOnly: true });
  try {
    let objs = sdb.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY (type = 'table') DESC, name").all();
    // FTS5/FTS4 keep internal "shadow" tables (_content, _data, _idx, _docsize, _config...): pure noise, the virtual table itself has the text
    const virtuals = objs.filter((o) => /^\s*create\s+virtual\s+table/i.test(o.sql)).map((o) => o.name);
    const isShadow = (n) => virtuals.some((v) => n.startsWith(`${v}_`) && /_(content|data|idx|docsize|config|segdir|segments|stat|node|rowid|parent)$/.test(n));
    objs = objs.filter((o) => !isShadow(o.name));
    let k = 0;
    for (const o of objs) {
      if (signal?.aborted) return;
      yield { start: ++k, end: k, title: `schema: ${o.type} ${o.name}`, text: String(o.sql).slice(0, 4000) };
    }
    for (const o of objs.filter((x) => x.type === 'table')) {
      let cols = [];
      try {
        cols = sdb.prepare(`PRAGMA table_info(${qIdent(o.name)})`).all().map((c) => c.name);
      } catch {
        continue;
      }
      let buf = [];
      let size = 0;
      let first = 1;
      let row = 0;
      const flush = () => {
        const out = buf.length ? { start: first, end: row, title: `table ${o.name}`, text: `Table ${o.name}\n${buf.join('\n')}` } : null;
        buf = [];
        size = 0;
        return out;
      };
      let it;
      try {
        it = sdb.prepare(`SELECT * FROM ${qIdent(o.name)}`).iterate();
      } catch {
        continue; // virtual table without its module, etc.
      }
      for (const r of it) {
        if (signal?.aborted) return;
        row++;
        const line = cols.map((c) => `${c}=${fmtCell(r[c])}`).join(' | ');
        if (size + line.length + 1 > STREAM_CHUNK_CHARS && buf.length) {
          const c = flush();
          if (c) yield c;
          if (row % 5000 === 0) await sleep0();
        }
        if (!buf.length) first = row;
        buf.push(line.slice(0, STREAM_CHUNK_CHARS));
        size += Math.min(line.length, STREAM_CHUNK_CHARS) + 1;
      }
      const c = flush();
      if (c) yield c;
    }
  } finally {
    sdb.close();
  }
}

function isSupported(file, { images = false } = {}) {
  const ext = path.extname(file).toLowerCase();
  return (
    TEXT_EXT.has(ext) || SQLITE_EXT.has(ext) || ZIP_DOC_EXT.has(ext) || SHEET_EXT.has(ext) || SLIDE_EXT.has(ext) || ext in LEGACY_EXT || ext === '.pdf' ||
    path.basename(file).toLowerCase() === 'dockerfile' || (images && IMAGE_EXT.has(ext))
  );
}

async function extractText(file, { ocr, signal } = {}) {
  const ext = path.extname(file).toLowerCase();
  if (ZIP_DOC_EXT.has(ext)) return extractZipDoc(file, ext);
  if (SHEET_EXT.has(ext)) return extractSheet(file, ext);
  if (SLIDE_EXT.has(ext)) return extractSlides(file, ext);
  if (ext in LEGACY_EXT) return extractLegacy(file, ext, signal);
  if (IMAGE_EXT.has(ext)) return ocr ? ocrImage(file, { lang: ocr.lang, signal }) : null;
  if (ext === '.pdf') {
    let text = '';
    try {
      const pdf = require('pdf-parse/lib/pdf-parse.js');
      text = (await pdf(fs.readFileSync(file))).text || '';
    } catch {
      text = ''; // pdf-parse missing or the PDF is unreadable
    }
    if (text.trim().length < 20 && ocr) text = await ocrPdf(file, { lang: ocr.lang, maxPages: ocr.maxPages, signal });
    return text;
  }
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) return null; // binary
  return buf.toString('utf8');
}

/**
 * Incrementally indexes the given roots into the BrainDB. Unchanged files (same mtime+size, or same
 * content hash) are not re-embedded.
 * @param {object} o
 * @param {{dir:string, kind:'doc'|'brain'}[]} o.roots allowed roots (brain notes first)
 * @param {BrainDB} o.db
 * @param {string} o.embedUrl
 * @param {string} [o.embedModel]
 * @param {string[]} [o.ignore] user ignore patterns
 * @param {{enabled:boolean,lang?:string,maxPages?:number}} [o.ocr]
 */
/**
 * Indexes with an idle watchdog: if nothing advances (no file/batch finished) for `idleTimeoutMs`
 * (default 5 min), cancels everything and fails with a clear message.
 */
async function indexFolders(opts) {
  const { signal: outer, onProgress, idleTimeoutMs = 5 * 60 * 1000 } = opts;
  const ac = new AbortController();
  const onOuter = () => ac.abort();
  if (outer?.aborted) ac.abort();
  outer?.addEventListener('abort', onOuter);
  let last = Date.now();
  let current = '';
  let timedOut = false;
  const timer = setInterval(() => {
    if (Date.now() - last > idleTimeoutMs) {
      timedOut = true;
      ac.abort();
    }
  }, Math.min(10000, Math.max(20, idleTimeoutMs / 4)));
  const fail = () =>
    new Error(
      tr('idx.stalled', {
        time: idleTimeoutMs >= 60000 ? tr('idx.min', { n: Math.round(idleTimeoutMs / 60000) }) : tr('idx.sec', { n: Math.round(idleTimeoutMs / 1000) }),
        file: current ? tr('idx.stalledAt', { name: path.basename(current) }) : '',
      }),
    );
  try {
    const r = await indexInner({
      ...opts,
      signal: ac.signal,
      onProgress: (p) => {
        last = Date.now();
        if (p.file) current = p.file;
        onProgress?.(p);
      },
    });
    if (timedOut) throw fail();
    return r;
  } catch (e) {
    if (timedOut) throw fail();
    throw e;
  } finally {
    clearInterval(timer);
    outer?.removeEventListener('abort', onOuter);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function indexInner({ roots, db, embedUrl, embedModel, ignore = [], ocr, onProgress, signal, batchSize = 16, errorLog, isPaused, exclude = [], sqliteEmbedMax = SQLITE_EMBED_MAX }) {
  // Problems never stop the run: they are listed (file, size, reason) in the error log and in the result.
  const excluded = new Set(exclude.map((x) => path.resolve(x)));
  try {
    db.removeOrphanChunks(); // leftovers of an interrupted huge-file run
  } catch {
    /* ignore */
  }
  const issues = [];
  const report = (issue) => {
    issues.push(issue);
    errorLog?.add(issue);
  };
  // Pause: waits between files / batches (RAM and CPU are free while it waits). Keeps the idle watchdog fed.
  const gate = async (extra) => {
    while (isPaused?.() && !signal?.aborted) {
      onProgress?.({ phase: 'paused', ...extra });
      await sleep(400);
    }
  };
  const ignored = makeIgnore(ignore);
  const seen = new Set();
  const todo = []; // {file, kind, stat}
  const skipped = {}; // extension -> count (unsupported types)
  const failed = []; // supported types without extractable text
  const warnings = [];

  let ocrOn = null;
  if (ocr?.enabled) {
    const st = await ocrStatus();
    if (st.tesseract) {
      ocrOn = { lang: ocr.lang || 'por+eng', maxPages: ocr.maxPages || 30 };
      if (!st.pdftoppm) warnings.push(tr('idx.noPdftoppm'));
    } else {
      warnings.push(tr('idx.noTesseract'));
    }
  }
  const imagesOn = !!ocrOn;

  onProgress?.({ phase: 'scan', done: 0, total: 0 });
  for (const { dir, kind } of roots) {
    for (const file of walk(dir, dir, ignored)) {
      if (seen.has(file)) continue;
      const base = path.basename(file);
      if (SECRET_RE.test(base)) continue;
      if (base.startsWith('~$') || base.startsWith('.~lock')) continue; // Word/LibreOffice temp files
      if (kind === 'brain' && GENERATED_NOTES.includes(base.toLowerCase())) continue;
      if (excluded.has(path.resolve(file))) continue; // the app's own databases
      if (!isSupported(file, { images: imagesOn })) {
        const ext = path.extname(file).toLowerCase() || tr('idx.noExt');
        skipped[ext] = (skipped[ext] || 0) + 1;
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      const bext = path.extname(file).toLowerCase();
      const big = bext === '.pdf' || IMAGE_EXT.has(bext) || SHEET_EXT.has(bext) || SLIDE_EXT.has(bext) || bext in LEGACY_EXT || ZIP_DOC_EXT.has(bext);
      // SQLite databases always, and .sql files above the normal text limit, are read as a stream (keyword-only)
      const stream = SQLITE_EXT.has(bext) || (bext === '.sql' && stat.size > MAX_TEXT_BYTES);
      const limit = stream ? MAX_STREAM_BYTES : big ? MAX_BIG_BYTES : MAX_TEXT_BYTES;
      if (stat.size > limit) {
        report({ path: file, kind: 'too_large', size: stat.size, limit });
        continue;
      }
      seen.add(file);
      todo.push({ file, kind, stat, stream });
    }
  }

  // Drop files that disappeared, or whose folder was removed from the allowed list.
  for (const known of db.listFiles()) {
    if (!seen.has(known.path)) {
      db.removeFile(known.path);
      db.logIndex({ path: known.path, action: 'removed', kind: known.kind, size: known.size });
    }
  }

  let done = 0;
  let indexed = 0;
  let unchanged = 0;
  /** Embeds chunks in batches. Returns { vectors } or { skip: true } when the embedding server refuses a chunk's size. */
  const embedChunks = async (file, chunks, stat) => {
    const name = path.basename(file);
    const vectors = [];
    for (let i = 0; i < chunks.length; i += batchSize) {
      await gate({ done, total: todo.length, file, indexed, unchanged, failed: failed.length });
      if (signal?.aborted) break;
      const batch = chunks
        .slice(i, i + batchSize)
        .map((c) => `File: ${name}\n${c.title ? `Section: ${c.title}\n` : ''}\n${c.text}`.slice(0, 2000));
      try {
        vectors.push(...(await embed(embedUrl, batch, { model: embedModel, signal })));
      } catch (e) {
        // A chunk the embedding server refuses for its size only skips this file; any other error (server down...) still stops the run.
        if (signal?.aborted || !/too large|batch size|exceeds|context (length|size)/i.test(String(e.message))) throw e;
        report({ path: file, kind: 'embed_too_large', size: stat.size, detail: String(e.message).split('\n')[0] });
        failed.push(`${name} (${tr('err.kind.embed_too_large')})`);
        return { skip: true };
      }
      onProgress?.({ phase: 'indexing', done, total: todo.length, file, indexed, unchanged, failed: failed.length }); // batch finished = progress was made
    }
    return { vectors };
  };

  for (const { file, kind, stat, stream } of todo) {
    if (signal?.aborted) break;
    await gate({ done, total: todo.length, file, indexed, unchanged, failed: failed.length });
    if (signal?.aborted) break;
    onProgress?.({ phase: 'indexing', done, total: todo.length, file, indexed, unchanged, failed: failed.length });
    done++;

    const meta = db.getFile(file);
    const oldHash = String(meta?.hash || '');
    const staleStream = !!meta && stream && !oldHash.startsWith(`stream:${STREAM_VERSION}:`) && !oldHash.startsWith(`sqlite:${STREAM_VERSION}:`); // streamed with an older reader: redo
    if (!staleStream && meta && meta.mtime === stat.mtimeMs && meta.size === stat.size && meta.kind === kind) {
      unchanged++;
      errorLog?.resolve(file);
      continue;
    }
    if (stream) {
      // keyword-only, block by block: pausing, cancelling and the idle watchdog all work between blocks
      const isDb = SQLITE_EXT.has(path.extname(file).toLowerCase());
      const gen = isDb ? sqliteChunks(file, signal) : sqlChunks(file, signal);
      let source = gen;
      let block = [];
      let n = 0;
      let chars = 0;
      let preview = '';
      try {
        if (isDb && sqliteEmbedMax > 0) {
          // Peek: a small database is embedded like any document; a big one continues as a keyword-only stream.
          const it = gen[Symbol.asyncIterator]();
          const head = [];
          let more = false;
          for (;;) {
            const r = await it.next();
            if (r.done) break;
            head.push(r.value);
            if (head.length > sqliteEmbedMax) {
              more = true;
              break;
            }
          }
          if (!more && head.length && !signal?.aborted) {
            const emb = await embedChunks(file, head, stat);
            if (signal?.aborted) break;
            if (!emb.skip) {
              db.addFile({ path: file, hash: `sqlite:${STREAM_VERSION}:${stat.size}:${stat.mtimeMs}`, mtime: stat.mtimeMs, size: stat.size, kind, chunks: head, vectors: emb.vectors });
              db.logIndex({ path: file, action: meta ? 'updated' : 'indexed', kind, size: stat.size, chunks: head.length, chars: head.reduce((a, c) => a + c.text.length, 0), preview: head.slice(0, 4).map((c) => c.text.replace(/\s+/g, ' ')).join(' ').slice(0, 400) });
              errorLog?.resolve(file);
              indexed++;
            }
            continue;
          }
          source = (async function* () {
            yield* head;
            for (;;) {
              const r = await it.next();
              if (r.done) return;
              yield r.value;
            }
          })();
        }
        db.beginStreamFile(file);
        for await (const c of source) {
          block.push(c);
          n++;
          chars += c.text.length;
          if (preview.length < 400) preview += `${c.text.replace(/\s+/g, ' ')} `;
          if (block.length >= STREAM_BLOCK) {
            db.addStreamChunks(file, kind, block);
            block = [];
            await gate({ done, total: todo.length, file, indexed, unchanged, failed: failed.length });
            if (signal?.aborted) break;
            onProgress?.({ phase: 'indexing', done, total: todo.length, file, indexed, unchanged, failed: failed.length, chunks: n });
            await sleep(0);
          }
        }
        if (signal?.aborted) {
          db.removeFile(file);
          break;
        }
        if (block.length) db.addStreamChunks(file, kind, block);
        if (!n) {
          db.removeFile(file);
          failed.push(tr('idx.noText', { name: path.basename(file) }));
          report({ path: file, kind: 'no_text', size: stat.size });
          continue;
        }
        db.finishStreamFile({ path: file, hash: `stream:${STREAM_VERSION}:${stat.size}:${stat.mtimeMs}`, mtime: stat.mtimeMs, size: stat.size, kind });
        db.logIndex({ path: file, action: meta ? 'updated' : 'indexed', kind, size: stat.size, chunks: n, chars, preview });
        errorLog?.resolve(file);
        indexed++;
      } catch (e) {
        try {
          db.removeFile(file);
        } catch {
          /* ignore */
        }
        if (signal?.aborted) break;
        failed.push(`${path.basename(file)} (${String(e.message).split('\n')[0].slice(0, 120)})`);
        report({ path: file, kind: 'extract_failed', size: stat.size, detail: String(e.message).split('\n')[0] });
      }
      continue;
    }
    let text;
    try {
      text = await extractText(file, { ocr: ocrOn, signal });
    } catch (e) {
      if (signal?.aborted) break;
      failed.push(`${path.basename(file)} (${String(e.message).split('\n')[0].slice(0, 120)})`);
      report({ path: file, kind: 'extract_failed', size: stat.size, detail: String(e.message).split('\n')[0] });
      continue;
    }
    if (!text || !text.trim()) {
      failed.push(tr('idx.noText', { name: path.basename(file) }));
      report({ path: file, kind: 'no_text', size: stat.size });
      continue;
    }
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    if (meta && meta.hash === hash && meta.kind === kind) {
      db.touchFile(file, stat.mtimeMs, stat.size);
      errorLog?.resolve(file);
      unchanged++;
      continue;
    }

    const chunks = chunkDocument(text, file);
    if (!chunks.length) continue;
    const name = path.basename(file);
    const emb = await embedChunks(file, chunks, stat);
    if (emb.skip) continue;
    if (signal?.aborted) break;
    const { vectors } = emb;
    db.addFile({ path: file, hash, mtime: stat.mtimeMs, size: stat.size, kind, chunks, vectors });
    db.logIndex({ path: file, action: meta ? 'updated' : 'indexed', kind, size: stat.size, chunks: chunks.length, chars: text.length, preview: text.replace(/\s+/g, ' ').trim() });
    errorLog?.resolve(file);
    indexed++;
  }

  onProgress?.({ phase: 'done', done: todo.length, total: todo.length, indexed, unchanged, failed: failed.length });
  errorLog?.pruneMissing();
  return { scanned: todo.length, indexed, unchanged, skipped, failed, warnings, issues, issueCount: errorLog ? errorLog.count() : issues.length, ...db.stats() };
}

module.exports = { extractText, indexFolders, walk, makeIgnore, SECRET_RE, isSupported, SKIP_DIRS };
