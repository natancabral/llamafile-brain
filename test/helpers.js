'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Deterministic bag-of-words embedding so "semantic" search works in tests. */
function fakeEmbed(text, dim = 64) {
  const v = new Array(dim).fill(0);
  for (const w of String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9_]+/g) || []) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % dim] += 1;
  }
  return v;
}

/**
 * Mock llamafile/OpenAI-compatible server.
 * opts: legacy (only /embedding), poolingError (/v1/embeddings -> 400 like pooling 'none'),
 *       chatReply, chatDelay (ms before streaming), rerank: 'reverse' | 'fail' | undefined
 */
function startMock(opts = {}) {
  const seen = { chatBodies: [], embedCalls: 0, rerankCalls: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const json = (obj, status = 200) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/health') return json({ status: 'ok' });

      if (req.url === '/v1/embeddings' && !opts.legacy) {
        if (opts.poolingError) {
          return json({ error: { code: 400, message: "Pooling type 'none' is not OAI compatible. Please use a different pooling type", type: 'invalid_request_error' } }, 400);
        }
        seen.embedCalls++;
        const { input } = JSON.parse(body);
        return json({ data: input.map((t, index) => ({ index, embedding: fakeEmbed(t) })) });
      }
      if (req.url === '/embedding' && (opts.legacy || opts.poolingError)) {
        seen.embedCalls++;
        const content = JSON.parse(body).content;
        if (opts.poolingError) return json([{ index: 0, embedding: [[1, 2], [3, 4]] }]);
        return json({ embedding: fakeEmbed(content) });
      }
      if (req.url === '/v1/chat/completions') {
        seen.chatBodies.push(JSON.parse(body));
        res.setHeader('Content-Type', 'text/event-stream');
        const reply = opts.chatReply ?? 'Resposta [1]';
        return setTimeout(() => {
          for (const piece of reply.match(/[\s\S]{1,6}/g)) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
        }, opts.chatDelay || 0);
      }
      if (req.url === '/v1/rerank' && opts.rerank) {
        seen.rerankCalls++;
        if (opts.rerank === 'fail') return json({ error: 'boom' }, 500);
        const { documents } = JSON.parse(body);
        return json({ results: documents.map((_, index) => ({ index, relevance_score: index })) }); // last doc is best
      }
      res.statusCode = 404;
      res.end('not found');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })),
  );
}

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lfb-'));

function baseSettings(url, extra = {}) {
  return {
    embed: { url, model: 'local' }, chat: { url, model: 'local' }, rerank: { enabled: false },
    topK: 4, contextChars: 4000, historyTurns: 2, temperature: 0.2, folders: [], brainDir: '',
    hybrid: { vectorWeight: 0.6 }, memory: { enabled: true, maxChars: 1500 }, profile: '', ...extra,
  };
}

module.exports = { fakeEmbed, startMock, tmpdir, baseSettings };
