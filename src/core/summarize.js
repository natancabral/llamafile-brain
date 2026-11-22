'use strict';

const path = require('node:path');
const { chatStream } = require('./client');
const I18N = require('../shared/i18n');
const tr = I18N.t;

// English, Portuguese and Spanish phrasings are understood regardless of the UI language.
const LIST_RE = /\b(list(e|ar|a)?|show|quais|mostre|mostrar|exib(a|ir)|ver|lista|muestra|mostrar|cu[aá]les)\b[^.?!]*\b(files|documents|arquivos|documentos|archivos)\b/i;
const SUMMARY_RE = new RegExp(
  '\\b(summari[sz]e|summary|overview|resum(o|a|ir|e|am|os)|resumen|resume)\\b[^.?!]*\\b(folder|files|documents|directory|everything|pasta|arquivos|documentos|documents|diret[óo]rio|tudo|carpeta|archivos|directorio|todo)\\b|' +
    '\\b(folder|files|documents|pasta|arquivos|documentos|carpeta|archivos)\\b[^.?!]*\\b(summari|resum)',
  'i',
);

/** 'summary' | 'list' | null */
function detectIntent(question) {
  if (SUMMARY_RE.test(question)) return 'summary';
  if (LIST_RE.test(question)) return 'list';
  return null;
}

function relPath(file, roots) {
  const root = roots.find((r) => file === r || file.startsWith(r + path.sep));
  return root ? path.relative(path.dirname(root), file) : file;
}

function allRoots(settings) {
  return [...(settings.brainDir ? [settings.brainDir] : []), ...(settings.folders || [])];
}

const emptyMsg = () => tr('sum.empty');

/** Deterministic: answers from the index itself, no model involved. */
function listFiles({ db, settings, onDelta }) {
  const files = db.listFiles();
  if (!files.length) {
    onDelta?.(emptyMsg());
    return { answer: emptyMsg(), sources: [] };
  }
  const counts = db.chunkCounts();
  const roots = allRoots(settings);
  const lines = files.map((f) => `- \`${relPath(f.path, roots)}\` — ${tr('sum.chunks', { n: counts[f.path] || 0 })}`);
  const answer = `${tr('sum.listH', { n: files.length })}\n\n${lines.join('\n')}`;
  onDelta?.(answer);
  return { answer, sources: [] };
}

async function complete(settings, system, user, { signal, maxTokens } = {}) {
  const out = await chatStream(
    settings.chat.url,
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { model: settings.chat.model, temperature: settings.temperature, maxTokens, signal },
  );
  return out.trim();
}

const FILE_SYSTEM = () =>
  `You summarize documents. In 2 to 3 sentences, written in ${I18N.PROMPT_LANG[I18N.getLang()]}, say what the document is about and its main points. Use only what is in the text; do not invent anything.`;
const OVERVIEW_SYSTEM = () =>
  `You receive summaries of several documents from a folder. Write an overview in ${I18N.PROMPT_LANG[I18N.getLang()]}, in Markdown, in at most 8 lines, grouped by theme (use lists). Cite the file names. Use only what is in the summaries.`;

/**
 * Map-reduce summary of every indexed file: one short summary per file, then an overview.
 * Streams progress through onDelta so the user sees it as it happens.
 */
async function summarizeFolder({ db, settings, signal, onDelta }) {
  const files = db.listFiles().map((f) => f.path);
  if (!files.length) {
    onDelta?.(emptyMsg());
    return { answer: emptyMsg(), sources: [] };
  }
  const maxFiles = settings.summaryMaxFiles || 40;
  const perFileChars = settings.summaryFileChars || 3500;
  const picked = files.slice(0, maxFiles);
  const roots = allRoots(settings);

  let out = '';
  const emit = (t) => {
    out += t;
    onDelta?.(t);
  };
  emit(`${tr('sum.progress', { n: picked.length, total: files.length })}\n\n`);

  const items = [];
  for (const file of picked) {
    if (signal?.aborted) throw new Error('aborted');
    const name = relPath(file, roots);
    const text = db.fileText(file, perFileChars);
    if (!text.trim()) continue;
    let summary;
    try {
      summary = await complete(settings, FILE_SYSTEM(), `Document: ${name}\n\n${text}`, { signal, maxTokens: 220 });
    } catch (e) {
      if (!items.length) throw e; // server down: fail loudly on the first file
      summary = tr('sum.fail', { e: e.message });
    }
    items.push({ name, summary });
    emit(`- **${name}** — ${summary.replace(/\n+/g, ' ')}\n`);
  }
  if (files.length > picked.length) {
    emit(`\n${tr('sum.more', { n: files.length - picked.length })}\n`);
  }
  if (items.length < 2) return { answer: out, sources: [] };

  // Reduce: batch if the combined summaries would not fit in the context budget.
  let parts = items.map((i) => `${i.name}: ${i.summary}`);
  const budget = settings.contextChars || 6000;
  while (parts.join('\n').length > budget && parts.length > 1) {
    const batches = [];
    let cur = [];
    let size = 0;
    for (const p of parts) {
      if (size + p.length > budget && cur.length) {
        batches.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(p);
      size += p.length;
    }
    if (cur.length) batches.push(cur);
    if (batches.length === parts.length) break; // cannot shrink further
    parts = [];
    for (const b of batches) {
      parts.push(await complete(settings, OVERVIEW_SYSTEM(), b.join('\n'), { signal, maxTokens: 300 }));
    }
  }

  emit(`\n\n---\n\n## ${tr('sum.overview')}\n\n`);
  await chatStream(
    settings.chat.url,
    [
      { role: 'system', content: OVERVIEW_SYSTEM() },
      { role: 'user', content: parts.join('\n').slice(0, budget * 2) },
    ],
    {
      model: settings.chat.model, temperature: settings.temperature, signal,
      onDelta: (d) => { out += d; onDelta?.(d); },
    },
  );
  return { answer: out, sources: [] };
}

module.exports = { detectIntent, listFiles, summarizeFolder, emptyMsg };
