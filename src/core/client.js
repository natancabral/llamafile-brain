'use strict';

const { t: tr } = require('../shared/i18n');

/**
 * Minimal OpenAI-compatible client (works with llamafile, llama.cpp, Ollama...).
 * Uses the global fetch (Node 18+ / Electron).
 */

const EMBED_TIMEOUT_MS = 5 * 60 * 1000;
const embedModeCache = new Map(); // baseUrl -> 'openai' | 'legacy'

function trimUrl(u) {
  return String(u || '').replace(/\/+$/, '');
}

async function postJson(url, body, signal, timeoutMs) {
  if (timeoutMs) signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-no-key-required' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new Error(tr('net.timeout', { min: Math.round(timeoutMs / 60000), url }));
    if (e.name === 'AbortError') throw e;
    const code = e.cause?.code || e.code;
    const where = (() => {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    })();
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || e.message === 'fetch failed') {
      throw new Error(tr('net.refused', { where, code: code || e.message }));
    }
    throw e;
  }
}

/** Returns an array of embedding vectors (arrays of numbers), same order as `texts`. */
async function embed(baseUrl, texts, { model = 'local', signal } = {}) {
  const base = trimUrl(baseUrl);
  const mode = embedModeCache.get(base);

  if (mode !== 'legacy') {
    const res = await postJson(`${base}/v1/embeddings`, { input: texts, model }, signal, EMBED_TIMEOUT_MS);
    if (res.ok) {
      embedModeCache.set(base, 'openai');
      const json = await res.json();
      const data = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return data.map((d) => d.embedding);
    }
    const body = (await res.text()).slice(0, 400);
    // 404/405: endpoint doesn't exist. 400 "Pooling type 'none'": the model has no pooling,
    // so the OpenAI-style endpoint refuses it; the native /embedding endpoint still works.
    if (res.status === 404 && /model/i.test(body) && /not found|pull/i.test(body)) {
      throw new Error(tr('ext.noModel', { model, body: body.slice(0, 200) }));
    }
    const poolingProblem = res.status === 400 && /pooling/i.test(body);
    if (res.status !== 404 && res.status !== 405 && !poolingProblem) {
      throw new Error(`Embeddings HTTP ${res.status}: ${body}`);
    }
    embedModeCache.set(base, 'legacy');
  }

  // Native llamafile/llama.cpp endpoint: POST /embedding {content}
  const out = [];
  for (const t of texts) {
    const res = await postJson(`${base}/embedding`, { content: t }, signal, EMBED_TIMEOUT_MS);
    if (!res.ok) {
      throw new Error(
        `Embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 300)}\n` +
          tr('net.embedHint'),
      );
    }
    const json = await res.json();
    let emb = Array.isArray(json) ? json[0]?.embedding : json.embedding;
    if (Array.isArray(emb?.[0])) emb = meanPool(emb); // pooling "none": one vector per token -> average them
    if (!emb || !emb.length) throw new Error(tr('net.embedUnexpected'));
    out.push(emb);
  }
  return out;
}

/** Averages a [tokens x dim] matrix into one vector. */
function meanPool(matrix) {
  const dim = matrix[0].length;
  const v = new Array(dim).fill(0);
  for (const row of matrix) for (let i = 0; i < dim; i++) v[i] += row[i];
  for (let i = 0; i < dim; i++) v[i] /= matrix.length;
  return v;
}

/**
 * Streams a chat completion. Calls onDelta(text) for each content token.
 * Returns the full text.
 */
async function chatStream(baseUrl, messages, { model = 'local', temperature = 0.2, maxTokens, signal, onDelta } = {}) {
  const base = trimUrl(baseUrl);
  const body = { model, messages, stream: true, temperature };
  if (maxTokens) body.max_tokens = maxTokens;

  const res = await postJson(`${base}/v1/chat/completions`, body, signal);
  if (!res.ok) throw new Error(`Chat HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return full;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta?.(delta);
        }
      } catch {
        /* ignore partial/keep-alive lines */
      }
    }
  }
  return full;
}

/** Polls until the server answers /health (or any HTTP response with 200). */
async function waitHealthy(baseUrl, { timeoutMs = 180000, signal } = {}) {
  const base = trimUrl(baseUrl);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server at ${base} did not become healthy in ${Math.round(timeoutMs / 1000)}s`);
}

/**
 * Checks an external server ("Start" in external mode): really calls it, so a wrong URL or model
 * name shows up right away instead of at the first question. Throws a readable error.
 */
async function checkExternal(kind, baseUrl, model = 'local') {
  const base = trimUrl(baseUrl);
  if (!base) throw new Error(tr('ext.noUrl'));
  if (kind === 'embed') {
    const v = await embed(base, ['ping'], { model });
    if (!Array.isArray(v?.[0]) || !v[0].length) throw new Error(tr('net.embedUnexpected'));
    return { dim: v[0].length };
  }
  if (kind === 'chat') {
    const res = await postJson(`${base}/v1/chat/completions`, { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }, null, 3 * 60 * 1000);
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      if (res.status === 404 && /model/i.test(body)) throw new Error(tr('ext.noModel', { model, body }));
      throw new Error(tr('ext.http', { status: res.status, body }));
    }
    return {};
  }
  // reranker: any HTTP answer from the server means it is up
  try {
    await fetch(base, { signal: AbortSignal.timeout(5000) });
  } catch (e) {
    const code = e.cause?.code || e.code;
    throw new Error(tr('net.refused', { where: base.replace(/^https?:\/\//, ''), code: code || e.message }));
  }
  return {};
}

module.exports = { embed, chatStream, waitHealthy, checkExternal };
