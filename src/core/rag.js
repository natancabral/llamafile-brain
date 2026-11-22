'use strict';

const { embed, chatStream } = require('./client');
const { detectIntent, listFiles, summarizeFolder } = require('./summarize');
const { rerank } = require('./rerank');
const { parseMemoryCommand, handleMemoryCommand, buildMemoryBlock } = require('./memory');

const { t: tr } = require('../shared/i18n');

// System prompts are English; the model is told to answer in the language of the user's latest message.
const BASE = `You are the assistant of the Llamafile Brain app, which runs locally on the user's computer.
You chat normally: answer general questions, do math, write and explain code, help draft texts.
Always reply in the language of the user's latest message, directly and concisely.
Format answers in Markdown: headings (##), lists, **bold**, tables and fenced code blocks with the language name.`;

// Used when there are file excerpts to consult.
const SYSTEM_WITH_FILES = `${BASE}

When there are "Excerpts from the user's files", they come from an automatic search and may be irrelevant:
- If the question is about the user's files, answer from the excerpts and cite sources as [1], [2].
- If the excerpts do not contain the answer, say you did not find it in the indexed files. Never invent file contents.
- If the question does not depend on the files, ignore the excerpts and answer normally.
You cannot access the disk yourself: you only see the excerpts provided. To list or summarize the files the user can say "list the files" or "summarize the folder". To save something to memory they can say "remember that ...".`;

// Used when no files are indexed or file search is turned off.
const SYSTEM_PLAIN = `${BASE}
You do not have access to the user's files yet. If they ask about files, explain that they need to add a folder under "Knowledge" and click "Index now"; after that they can ask about the content, say "list the files" or "summarize the folder". To save something to memory they can say "remember that ...".`;

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
  const reply = (text) => {
    onSources?.([]);
    onDelta?.(text);
    return { answer: text, sources: [] };
  };

  // 1) Memory commands are executed by code, not by the model.
  if (settings.memory?.enabled !== false) {
    const cmd = parseMemoryCommand(question);
    if (cmd) return reply(handleMemoryCommand(cmd, db));
  }

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
  if (useFiles && db.stats().chunks > 0) {
    const hits = await retrieve({ question, db, settings, signal, onWarn });
    const ctx = buildContext(hits, settings.contextChars);
    kept = ctx.sources;
    contextText = ctx.text;
  }

  const userContent = contextText
    ? `Excerpts from the user's files (may be irrelevant):\n\n${contextText}\n\n---\nQuestion: ${question}`
    : question;

  const memoryBlock = buildMemoryBlock(db, question, {
    profile: settings.profile,
    memoryEnabled: settings.memory?.enabled !== false,
    maxChars: settings.memory?.maxChars || 1500,
  });
  const system = (contextText ? SYSTEM_WITH_FILES : SYSTEM_PLAIN) + (memoryBlock ? `\n\n${memoryBlock}` : '');

  const messages = [
    { role: 'system', content: system },
    ...history.slice(-settings.historyTurns * 2).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent },
  ];

  const answer = await chatStream(settings.chat.url, messages, {
    model: settings.chat.model,
    temperature: settings.temperature,
    signal,
    onDelta,
  });

  const sources = citedSources(answer, kept).map((s) => ({ path: s.path, start: s.start, end: s.end, score: s.score }));
  onSources?.(sources);
  return { answer, sources };
}

module.exports = { ask, retrieve, buildContext, citedSources };
