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

function isSupported(file, { images = false } = {}) {
  const ext = path.extname(file).toLowerCase();
  return (
    TEXT_EXT.has(ext) || ZIP_DOC_EXT.has(ext) || SHEET_EXT.has(ext) || SLIDE_EXT.has(ext) || ext in LEGACY_EXT || ext === '.pdf' ||
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

async function indexInner({ roots, db, embedUrl, embedModel, ignore = [], ocr, onProgress, signal, batchSize = 16 }) {
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

  for (const { dir, kind } of roots) {
    for (const file of walk(dir, dir, ignored)) {
      if (seen.has(file)) continue;
      const base = path.basename(file);
      if (SECRET_RE.test(base)) continue;
      if (base.startsWith('~$') || base.startsWith('.~lock')) continue; // Word/LibreOffice temp files
      if (kind === 'brain' && GENERATED_NOTES.includes(base.toLowerCase())) continue;
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
      if (stat.size > (big ? MAX_BIG_BYTES : MAX_TEXT_BYTES)) continue;
      seen.add(file);
      todo.push({ file, kind, stat });
    }
  }

  // Drop files that disappeared, or whose folder was removed from the allowed list.
  for (const known of db.listFiles()) {
    if (!seen.has(known.path)) db.removeFile(known.path);
  }

  let done = 0;
  let indexed = 0;
  let unchanged = 0;
  for (const { file, kind, stat } of todo) {
    if (signal?.aborted) break;
    onProgress?.({ phase: 'indexing', done, total: todo.length, file });
    done++;

    const meta = db.getFile(file);
    if (meta && meta.mtime === stat.mtimeMs && meta.size === stat.size && meta.kind === kind) {
      unchanged++;
      continue;
    }
    let text;
    try {
      text = await extractText(file, { ocr: ocrOn, signal });
    } catch (e) {
      if (signal?.aborted) break;
      failed.push(`${path.basename(file)} (${String(e.message).split('\n')[0].slice(0, 120)})`);
      continue;
    }
    if (!text || !text.trim()) {
      failed.push(tr('idx.noText', { name: path.basename(file) }));
      continue;
    }
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    if (meta && meta.hash === hash && meta.kind === kind) {
      db.touchFile(file, stat.mtimeMs, stat.size);
      unchanged++;
      continue;
    }

    const chunks = chunkDocument(text, file);
    if (!chunks.length) continue;
    const name = path.basename(file);
    const vectors = [];
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks
        .slice(i, i + batchSize)
        .map((c) => `File: ${name}\n${c.title ? `Section: ${c.title}\n` : ''}\n${c.text}`.slice(0, 2000));
      vectors.push(...(await embed(embedUrl, batch, { model: embedModel, signal })));
      onProgress?.({ phase: 'indexing', done, total: todo.length, file }); // batch finished = progress was made
    }
    db.addFile({ path: file, hash, mtime: stat.mtimeMs, size: stat.size, kind, chunks, vectors });
    indexed++;
  }

  onProgress?.({ phase: 'done', done: todo.length, total: todo.length });
  return { scanned: todo.length, indexed, unchanged, skipped, failed, warnings, ...db.stats() };
}

module.exports = { extractText, indexFolders, walk, makeIgnore, SECRET_RE, isSupported, SKIP_DIRS };
