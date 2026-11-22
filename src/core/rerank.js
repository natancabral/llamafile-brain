'use strict';

const { t: tr } = require('../shared/i18n');

/**
 * Optional cross-encoder reranking through a llama.cpp/llamafile-style rerank endpoint
 * (POST /v1/rerank or /reranking with {query, documents, top_n}), serving a reranker model
 * (e.g. bge-reranker-v2-m3, started with --embedding --pooling rank --reranking).
 * Returns the hits reordered by relevance; on any failure returns them unchanged.
 */
async function rerank(hits, query, { url, model = 'local', topN, signal, onWarn } = {}) {
  if (!url || hits.length < 2) return hits;
  const base = String(url).replace(/\/+$/, '');
  const body = JSON.stringify({
    model,
    query,
    documents: hits.map((h) => h.text.slice(0, 2000)),
    top_n: topN || hits.length,
  });
  for (const ep of ['/v1/rerank', '/rerank', '/reranking']) {
    try {
      const res = await fetch(base + ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-no-key-required' },
        body,
        signal,
      });
      if (res.status === 404 || res.status === 405) continue;
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = await res.json();
      const results = json.results || json.data;
      if (!Array.isArray(results)) throw new Error('resposta de rerank inesperada');
      const ordered = [...results]
        .sort((a, b) => (b.relevance_score ?? b.score ?? 0) - (a.relevance_score ?? a.score ?? 0))
        .map((r) => hits[r.index])
        .filter(Boolean);
      return ordered.length ? ordered : hits;
    } catch (e) {
      if (signal?.aborted) throw e;
      onWarn?.(tr('rerank.failed', { e: e.message }));
      return hits;
    }
  }
  onWarn?.(tr('rerank.noEndpoint'));
  return hits;
}

module.exports = { rerank };
