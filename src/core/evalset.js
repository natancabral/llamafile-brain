'use strict';

/**
 * Retrieval evaluation. One test per line:
 *     pergunta => trecho-esperado
 * "trecho-esperado" is matched (case/accent-insensitive) against the hit's file path OR its text.
 * Reports hit@k and MRR so you can tell if a change (chunking, weights, reranker, model) helped.
 */
const { norm } = require('./db');

function parseEvalSet(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.lastIndexOf('=>');
      if (i < 0) return null;
      const question = l.slice(0, i).trim();
      const expected = l.slice(i + 2).trim();
      return question && expected ? { question, expected } : null;
    })
    .filter(Boolean);
}

/**
 * @param {string} text eval set
 * @param {(q:string)=>Promise<Array<{path:string,text:string}>>} retrieve returns ranked hits
 */
async function runEval(text, retrieve, { onProgress } = {}) {
  const tests = parseEvalSet(text);
  const results = [];
  let hits = 0;
  let rr = 0;
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    onProgress?.({ done: i, total: tests.length });
    let rank = 0;
    let error = null;
    try {
      const found = await retrieve(t.question);
      const exp = norm(t.expected);
      const idx = found.findIndex((h) => norm(h.path).includes(exp) || norm(h.text).includes(exp));
      rank = idx >= 0 ? idx + 1 : 0;
    } catch (e) {
      error = e.message;
    }
    if (rank) {
      hits++;
      rr += 1 / rank;
    }
    results.push({ ...t, rank, error });
  }
  const n = tests.length || 1;
  return { total: tests.length, hitRate: hits / n, mrr: rr / n, results };
}

module.exports = { parseEvalSet, runEval };
