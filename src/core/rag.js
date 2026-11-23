'use strict';

const { embed, chatStream } = require('./client');
const { detectIntent, listFiles, summarizeFolder } = require('./summarize');
const { rerank } = require('./rerank');
const { parseSysInfoIntent, answerSysInfo, systemContextBlock } = require('./sysinfo');
const { parseMemoryCommand, handleMemoryCommand, buildMemoryBlock, norm } = require('./memory');

const { t: tr } = require('../shared/i18n');

// System prompts are English; the model is told to answer in the language of the user's latest message.
const BASE = `You are the assistant of the Llamafile Brain app, which runs locally on the user's computer.
You chat normally: answer general questions, do math, write and explain code, help draft texts.
Always reply in the language of the user's latest message, directly and concisely.
Format answers in Markdown: headings (##), lists, **bold**, tables and fenced code blocks with the language name.`;

// Hidden rules sent with every request so the model does not make things up.
const HONESTY = `Honesty rules (always):
- Never invent facts, names, numbers, dates, file names, paths, quotes, URLs or code that you were not given or do not actually know. A short honest "I don't know" or "I did not find that" is better than a guess.
- If you are unsure, say so plainly and say what you are unsure about. Do not fill gaps with plausible-sounding details.
- Do not claim you ran, opened, searched or accessed anything you did not (you cannot browse the web or run commands).
- Keep general knowledge separate from what comes from the user's files.`;

// Used when there are file excerpts to consult.
const SYSTEM_WITH_FILES = `${BASE}

${HONESTY}

When there are "Excerpts from the user's files", they come from an automatic search and may be irrelevant:
- If the question is about the user's files, answer ONLY from the excerpts and cite the sources as [1], [2] after each claim taken from them. Do not add details that are not in the excerpts.
- If the excerpts do not contain the answer, reply that you did not find it in the indexed files. Never invent file contents.
- If the question does not depend on the files, ignore the excerpts and answer normally.
You cannot access the disk yourself: you only see the excerpts provided. To list or summarize the files the user can say "list the files" or "summarize the folder". To save something to memory they can say "remember that ...".`;

// Used when no files are indexed, file search is turned off, or nothing relevant was found.
const SYSTEM_PLAIN = `${BASE}

${HONESTY}
You do not have access to the user's files yet. If they ask about files, explain that they need to add a folder under "Knowledge" and click "Index now"; after that they can ask about the content, say "list the files" or "summarize the folder". To save something to memory they can say "remember that ...".`;

// ---- evidence: how well the retrieved excerpts support an answer (computed from the search, not guessed by the model)
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const FILE_REF_RE = new RegExp(
  '\\b(?:' +
    'meus?\\s+(?:arquivos?|documentos?|notas?|pastas?|projetos?)|(?:nos?|nas?)\\s+(?:meus\\s+|minhas\\s+)?(?:arquivos?|documentos?|pastas?|projetos?|notas)|' + // pt
    '(?:my|the|in|from)\\s+(?:my\\s+|the\\s+)?(?:files?|documents?|notes|folders?|docs)|according\\s+to\\s+(?:the|my)\\s+\\w+|' + // en
    '(?:mis|los|en\\s+mis|en\\s+los)\\s+(?:archivos|documentos|notas)|' + // es
    'indexad[oa]s?|base\\s+de\\s+conhecimento|knowledge\\s+base' +
    ')\\b|\\.(?:md|pdf|docx?|xlsx?|pptx?|sql|txt|csv|sqlite|js|ts|py)\\b',
  'i',
);
const asksAboutFiles = (q) => FILE_REF_RE.test(norm(q));

/** Strength of the evidence in 0..1 plus whether it is worth showing to the model at all. */
function assessEvidence(hits, { minCos = 0.38 } = {}) {
  if (!hits.length) return { base: 0, usable: false };
  const cos = hits.map((h) => (typeof h.cos === 'number' ? h.cos : null)).filter((c) => c != null);
  const maxCos = cos.length ? Math.max(...cos) : null;
  const kw = hits.filter((h) => typeof h.bm25 === 'number').length;
  // Keyword-only hits (excerpts without a vector: huge .sql / SQLite files) cannot be judged by cosine: judge them by bm25 strength
  // (more negative = better; rare-term matches reach -5..-15, a stray common word stays around -0.5).
  const kwOnly = hits.filter((h) => typeof h.cos !== 'number' && typeof h.bm25 === 'number').map((h) => -h.bm25);
  const kwBest = kwOnly.length ? Math.max(...kwOnly) : 0;
  let base;
  let usable;
  if (kwBest >= 2 && (maxCos == null || maxCos < minCos)) {
    base = clamp01(kwBest / 12) * 0.6 + clamp01(kwOnly.filter((x) => x >= 2).length / 4) * 0.15;
    usable = true;
  } else if (maxCos != null) {
    // 0.30 -> nothing, 0.75 -> full; keyword agreement and several good excerpts add a little
    base = clamp01((maxCos - 0.3) / 0.45) * 0.75 + (maxCos >= 0.3 ? clamp01(kw / 2) * 0.15 : 0) + (Math.min(cos.filter((c) => c >= minCos).length, 3) / 3) * 0.1;
    usable = maxCos >= minCos;
  } else {
    // embeddings server was down: keyword search only
    base = clamp01(kw / 4) * 0.55;
    usable = kw > 0;
  }
  return { base: clamp01(base), usable };
}
/** Final percentage after the answer: citing sources raises it, an uncited answer lowers it. Never 0 or 100 for an answer. */
function finalConfidence(ev, answer, kept) {
  const cited = citedSources(answer, kept).length > 0;
  const pct = Math.round(Math.max(5, Math.min(95, ev.base * 100 + (cited ? 8 : -20))));
  return { pct, level: pct >= 70 ? 'high' : pct >= 40 ? 'mid' : 'low', cited };
}

function buildContext(hits, maxChars) {
  let used = 0;
  const parts = [];
  const kept = [];
  for (const h of hits) {
    const header = `[${kept.length + 1}] ${h.path}:${h.start}-${h.end}${h.title ? ` (${h.title})` : ''}`;
    const block = `${header}\n${h.text}`;
    if (used + block.length > maxChars && kept.length) break;
    parts.push(block.slice(0, maxChars));
    kept.push(h);
    used += block.length;
  }
  return { text: parts.join('\n\n---\n\n'), sources: kept };
}

/** Keeps only the excerpts the answer actually cites as [n]. */
function citedSources(answer, kept) {
  const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  return kept.filter((_, i) => cited.has(i + 1));
}

/**
 * Hybrid retrieval: embeds the query (falls back to keyword-only if the embedding server is down),
 * fuses vector + FTS5 results, then optionally reranks with a cross-encoder.
 */
async function retrieve({ question, db, settings, signal, onWarn }) {
  const rr = settings.rerank?.enabled ? settings.rerank : null;
  const limit = rr ? Math.max(settings.topK, rr.candidates || 20) : settings.topK;

  let queryVec = null;
  try {
    [queryVec] = await embed(settings.embed.url, [question], { model: settings.embed.model, signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    onWarn?.(tr('chat.embedDown', { e: e.message.split('\n')[0] }));
  }
  let hits = db.search({
    queryVec, queryText: question, limit, vectorWeight: settings.hybrid?.vectorWeight ?? 0.6,
  });
  if (rr) {
    hits = await rerank(hits, question, { url: rr.url, model: rr.model, topN: settings.topK, signal, onWarn });
  }
  return hits.slice(0, settings.topK);
}

/**
 * Chat with memory + optional file context.
 * Returns { answer, sources } where sources are only the excerpts cited in the answer.
 */
async function ask({ question, history = [], db, settings, signal, onSources, onDelta, onWarn }) {
  const reply = (text, confidence = null) => {
    onSources?.([]);
    onDelta?.(text);
    return { answer: text, sources: [], confidence };
  };

  // 1) Memory commands are executed by code, not by the model.
  if (settings.memory?.enabled !== false) {
    const cmd = parseMemoryCommand(question);
    if (cmd) return reply(handleMemoryCommand(cmd, db));
  }

  // 1b) Questions about this computer (RAM, GPU, name, model, MAC...) are answered by code with real data.
  const sys = parseSysInfoIntent(question);
  if (sys) return reply(await answerSysInfo(sys));

  // 2) Questions about the folder as a whole can't use top-k retrieval.
  const intent = detectIntent(question);
  if (intent === 'summary') {
    onSources?.([]);
    return summarizeFolder({ db, settings, signal, onDelta });
  }
  if (intent === 'list') {
    onSources?.([]);
    return listFiles({ db, settings, onDelta });
  }

  // 3) Normal chat, with file context when available.
  const useFiles = settings.useFiles !== false;
  let kept = [];
  let contextText = '';
  let evidence = null;
  if (useFiles && db.stats().chunks > 0) {
    const hits = await retrieve({ question, db, settings, signal, onWarn });
    evidence = assessEvidence(hits, { minCos: settings.grounding?.minCos ?? 0.38 });
    if (evidence.usable) {
      const ctx = buildContext(hits, settings.contextChars);
      kept = ctx.sources;
      contextText = ctx.text;
    } else if (settings.grounding?.strict !== false && asksAboutFiles(question)) {
      // The question is about the user's files and nothing relevant was found: answer without calling the model (no room to make things up).
      return reply(tr('rag.noEvidence'), { pct: 0, level: 'none', cited: false });
    }
    // not usable and not about the files: irrelevant excerpts are not sent at all
  }

  const userContent = contextText
    ? `Excerpts from the user's files (may be irrelevant):\n\n${contextText}\n\n---\nQuestion: ${question}`
    : question;

  const memoryBlock = buildMemoryBlock(db, question, {
    profile: settings.profile,
    memoryEnabled: settings.memory?.enabled !== false,
    maxChars: settings.memory?.maxChars || 1500,
  });
  const strength = evidence && contextText ? (evidence.base >= 0.7 ? 'high' : evidence.base >= 0.4 ? 'medium' : 'low') : '';
  const system =
    (contextText ? SYSTEM_WITH_FILES : SYSTEM_PLAIN) +
    (strength ? `\n\nEvidence strength of the excerpts for this question: ${strength}. If it is not high, say clearly which parts you are unsure about and do not guess.` : '') +
    `\n\n${systemContextBlock()}` +
    (memoryBlock ? `\n\n${memoryBlock}` : '');

  const messages = [
    { role: 'system', content: system },
    ...history.slice(-settings.historyTurns * 2).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent },
  ];

  const answer = await chatStream(settings.chat.url, messages, {
    model: settings.chat.model,
    temperature: contextText ? Math.min(settings.temperature, 0.1) : settings.temperature, // grounded answers: no creativity
    signal,
    onDelta,
  });

  const sources = citedSources(answer, kept).map((s) => ({ path: s.path, start: s.start, end: s.end, score: s.score }));
  onSources?.(sources);
  const confidence = evidence && contextText ? finalConfidence(evidence, answer, kept) : null;
  return { answer, sources, confidence };
}

module.exports = { ask, retrieve, buildContext, citedSources, assessEvidence, finalConfidence, asksAboutFiles };
