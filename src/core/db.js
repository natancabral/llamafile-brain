'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('./sqlite');
const { t: tr } = require('../shared/i18n');

const STOPWORDS = new Set(
  ('de da do das dos em no na nos nas um uma uns umas o a os as e ou que para por com sem sobre qual quais como ' +
    'onde quando quem foi sao ser tem ter the of and to in is are for with what which how where when who').split(' '),
);

/** lowercase + strip accents, for substring matching in JS */
function norm(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Builds a safe FTS5 query: "term"* OR "term2" ... (prefix match for longer terms). */
function ftsQuery(text) {
  const terms = [...new Set((String(text).match(/[\p{L}\p{N}_]{2,}/gu) || []).map((t) => t.toLowerCase()))]
    .filter((t) => !STOPWORDS.has(norm(t)))
    .slice(0, 12);
  if (!terms.length) return null;
  return terms.map((t) => (t.length >= 4 ? `"${t}"*` : `"${t}"`)).join(' OR ');
}

function toBlob(f32) {
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}
function fromBlob(u8) {
  const copy = u8.slice(); // fresh, aligned buffer
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}
function normalize(arr) {
  const v = Float32Array.from(arr);
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/**
 * Everything the app remembers lives in one SQLite file:
 *   files / chunks (+FTS5 keyword index, embeddings as BLOB) and memories (+FTS5).
 * Vector search is brute-force cosine over an in-memory matrix loaded lazily (fine up to ~100k chunks);
 * keyword search uses FTS5/bm25; both are fused with Reciprocal Rank Fusion.
 */
class BrainDB {
  constructor(file) {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = openDatabase(file);
    this._migrate();
    this._cache = null;
    this.profileId = this.defaultProfileId(); // memories and chats are scoped to the active profile
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY, hash TEXT, mtime REAL, size INTEGER, kind TEXT, indexed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, kind TEXT,
        start_line INTEGER, end_line INTEGER, title TEXT, text TEXT NOT NULL, embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, title, tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at INTEGER
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, title TEXT NOT NULL,
        created_at INTEGER, updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS conversations_profile ON conversations(profile_id, updated_at);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, sources TEXT, created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, id);
    `);
    if (!this.db.prepare('PRAGMA table_info(memories)').all().some((c) => c.name === 'profile_id')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN profile_id INTEGER');
    }
    if (!this.db.prepare('SELECT 1 x FROM profiles LIMIT 1').get()) {
      this.db.prepare('INSERT INTO profiles(name, instructions, created_at) VALUES(?,?,?)').run(tr('prof.default'), '', Date.now());
    }
    this.db.prepare('UPDATE memories SET profile_id = ? WHERE profile_id IS NULL').run(this.defaultProfileId());
  }

  // ---------------------------------------------------------------- profiles (separate contexts: work, personal...)
  defaultProfileId() {
    return this.db.prepare('SELECT id FROM profiles ORDER BY id LIMIT 1').get().id;
  }
  listProfiles() {
    return this.db.prepare('SELECT id, name, instructions FROM profiles ORDER BY id').all();
  }
  getProfile(id) {
    return this.db.prepare('SELECT id, name, instructions FROM profiles WHERE id = ?').get(id);
  }
  setProfile(id) {
    this.profileId = this.getProfile(id) ? id : this.defaultProfileId();
    return this.profileId;
  }
  createProfile(name, instructions = '') {
    const n = String(name || '').trim().slice(0, 60);
    if (!n) throw new Error(tr('prof.nameEmpty'));
    const r = this.db.prepare('INSERT INTO profiles(name, instructions, created_at) VALUES(?,?,?)').run(n, String(instructions).slice(0, 1500), Date.now());
    return Number(r.lastInsertRowid);
  }
  updateProfile(id, { name, instructions }) {
    const cur = this.getProfile(id);
    if (!cur) return;
    const n = name == null ? cur.name : String(name).trim().slice(0, 60) || cur.name;
    const ins = instructions == null ? cur.instructions : String(instructions).slice(0, 1500);
    this.db.prepare('UPDATE profiles SET name = ?, instructions = ? WHERE id = ?').run(n, ins, id);
  }
  /** Deletes a profile with its chats and memories. The last remaining profile cannot be deleted. */
  deleteProfile(id) {
    if (this.listProfiles().length <= 1) throw new Error(tr('prof.last'));
    this._tx(() => {
      this.db.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE profile_id = ?)').run(id);
      this.db.prepare('DELETE FROM conversations WHERE profile_id = ?').run(id);
      this.db.prepare('DELETE FROM memories_fts WHERE rowid IN (SELECT id FROM memories WHERE profile_id = ?)').run(id);
      this.db.prepare('DELETE FROM memories WHERE profile_id = ?').run(id);
      this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    });
    if (this.profileId === id) this.profileId = this.defaultProfileId();
  }

  // ---------------------------------------------------------------- conversations (saved chats of the active profile)
  listConversations() {
    return this.db
      .prepare('SELECT id, title, updated_at FROM conversations WHERE profile_id = ? ORDER BY updated_at DESC, id DESC')
      .all(this.profileId);
  }
  createConversation(title = '') {
    const now = Date.now();
    const r = this.db.prepare('INSERT INTO conversations(profile_id, title, created_at, updated_at) VALUES(?,?,?,?)').run(this.profileId, String(title).trim().slice(0, 80) || tr('chat.newTitle'), now, now);
    return Number(r.lastInsertRowid);
  }
  getMessages(conversationId) {
    const own = this.db.prepare('SELECT 1 x FROM conversations WHERE id = ? AND profile_id = ?').get(conversationId, this.profileId);
    if (!own) return [];
    return this.db
      .prepare('SELECT id, role, content, sources FROM messages WHERE conversation_id = ? ORDER BY id')
      .all(conversationId)
      .map((m) => ({ ...m, sources: m.sources ? JSON.parse(m.sources) : [] }));
  }
  addMessage(conversationId, role, content, sources = null) {
    const now = Date.now();
    this.db.prepare('INSERT INTO messages(conversation_id, role, content, sources, created_at) VALUES(?,?,?,?,?)').run(conversationId, role, content, sources && sources.length ? JSON.stringify(sources) : null, now);
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
  }
  renameConversation(id, title) {
    const t = String(title).trim().slice(0, 80);
    if (t) this.db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND profile_id = ?').run(t, id, this.profileId);
  }
  deleteConversation(id) {
    this._tx(() => {
      this.db.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE id = ? AND profile_id = ?)').run(id, this.profileId);
      this.db.prepare('DELETE FROM conversations WHERE id = ? AND profile_id = ?').run(id, this.profileId);
    });
  }
  deleteAllConversations() {
    this._tx(() => {
      this.db.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE profile_id = ?)').run(this.profileId);
      this.db.prepare('DELETE FROM conversations WHERE profile_id = ?').run(this.profileId);
    });
  }

  _tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  _getMeta(k) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value;
  }
  _setMeta(k, v) {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  }

  // ---------------------------------------------------------------- files / chunks
  getFile(p) {
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(p);
  }
  listFiles() {
    return this.db.prepare('SELECT * FROM files ORDER BY path').all();
  }
  touchFile(p, mtime, size) {
    this.db.prepare('UPDATE files SET mtime = ?, size = ? WHERE path = ?').run(mtime, size, p);
  }

  removeFile(p) {
    this._tx(() => {
      this.db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE path = ?)').run(p);
      this.db.prepare('DELETE FROM chunks WHERE path = ?').run(p);
      this.db.prepare('DELETE FROM files WHERE path = ?').run(p);
    });
    this._cache = null;
  }

  /** Replaces a file's chunks. chunks: [{start,end,title,text}], vectors: number[][] (same length). */
  addFile({ path: p, hash, mtime, size, kind = 'doc', chunks, vectors }) {
    const dim = Number(this._getMeta('dim')) || 0;
    if (vectors.length && dim && vectors[0].length !== dim) {
      throw new Error(tr('db.dimChanged', { a: vectors[0].length, b: dim }));
    }
    this._tx(() => {
      this.db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE path = ?)').run(p);
      this.db.prepare('DELETE FROM chunks WHERE path = ?').run(p);
      const ins = this.db.prepare(
        'INSERT INTO chunks(path,kind,start_line,end_line,title,text,embedding) VALUES(?,?,?,?,?,?,?)',
      );
      const fts = this.db.prepare('INSERT INTO chunks_fts(rowid,text,title) VALUES(?,?,?)');
      chunks.forEach((c, i) => {
        const vec = vectors[i] ? toBlob(normalize(vectors[i])) : null;
        const r = ins.run(p, kind, c.start, c.end, c.title || null, c.text, vec);
        fts.run(Number(r.lastInsertRowid), c.text, c.title || '');
      });
      this.db
        .prepare(
          'INSERT INTO files(path,hash,mtime,size,kind,indexed_at) VALUES(?,?,?,?,?,?) ' +
            'ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, mtime=excluded.mtime, size=excluded.size, kind=excluded.kind, indexed_at=excluded.indexed_at',
        )
        .run(p, hash, mtime ?? null, size ?? null, kind, Date.now());
      if (vectors.length && !dim) this._setMeta('dim', vectors[0].length);
    });
    this._cache = null;
  }

  /** Clears the document index (memories are kept). */
  clear() {
    this._tx(() => {
      this.db.exec('DELETE FROM chunks_fts; DELETE FROM chunks; DELETE FROM files; DELETE FROM meta WHERE key = \'dim\';');
    });
    this._cache = null;
  }

  stats() {
    const files = this.db.prepare('SELECT COUNT(*) n FROM files').get().n;
    const chunks = this.db.prepare('SELECT COUNT(*) n FROM chunks').get().n;
    const memories = this.db.prepare('SELECT COUNT(*) n FROM memories WHERE profile_id = ?').get(this.profileId).n;
    return { files, chunks, memories, dim: Number(this._getMeta('dim')) || 0, dbFile: this.file };
  }

  chunkCounts() {
    const out = {};
    for (const r of this.db.prepare('SELECT path, COUNT(*) n FROM chunks GROUP BY path').all()) out[r.path] = r.n;
    return out;
  }

  /** Text of a file (first chunks, joined) up to maxChars. */
  fileText(p, maxChars) {
    let out = '';
    for (const r of this.db.prepare('SELECT text FROM chunks WHERE path = ? ORDER BY id').all(p)) {
      out += r.text + '\n';
      if (out.length >= maxChars) break;
    }
    return out.slice(0, maxChars);
  }

  // ---------------------------------------------------------------- search
  _loadVectors() {
    if (this._cache) return this._cache;
    const rows = this.db.prepare('SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL ORDER BY id').all();
    const dim = Number(this._getMeta('dim')) || 0;
    const ids = new Array(rows.length);
    const data = new Float32Array(rows.length * dim);
    rows.forEach((r, i) => {
      ids[i] = r.id;
      data.set(fromBlob(r.embedding), i * dim);
    });
    this._cache = { ids, data, dim };
    return this._cache;
  }

  _vectorRank(queryVec, n) {
    const { ids, data, dim } = this._loadVectors();
    if (!ids.length) return [];
    const q = normalize(queryVec);
    if (q.length !== dim) {
      throw new Error(tr('db.dimQuery'));
    }
    const scored = new Array(ids.length);
    for (let i = 0; i < ids.length; i++) {
      let dot = 0;
      const off = i * dim;
      for (let j = 0; j < dim; j++) dot += data[off + j] * q[j];
      scored[i] = { id: ids[i], cos: dot };
    }
    scored.sort((a, b) => b.cos - a.cos);
    return scored.slice(0, n);
  }

  _ftsRank(text, n) {
    const q = ftsQuery(text);
    if (!q) return [];
    try {
      return this.db
        .prepare('SELECT rowid AS id, bm25(chunks_fts, 1.0, 2.0) AS s FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY s LIMIT ?')
        .all(q, n);
    } catch {
      return []; // malformed query: fall back to vector only
    }
  }

  /**
   * Hybrid search: vector (cosine) + keyword (FTS5/bm25) fused with Reciprocal Rank Fusion.
   * @param {{queryVec?:number[]|null, queryText:string, limit:number, vectorWeight?:number, pool?:number}} o
   */
  search({ queryVec = null, queryText = '', limit = 6, vectorWeight = 0.6, pool = 50 }) {
    const K = 60;
    const fused = new Map(); // id -> {score, cos, bm25}
    const bump = (id, add, patch) => {
      const cur = fused.get(id) || { score: 0 };
      cur.score += add;
      Object.assign(cur, patch);
      fused.set(id, cur);
    };

    if (queryVec) {
      this._vectorRank(queryVec, pool).forEach((r, i) => bump(r.id, vectorWeight / (K + i + 1), { cos: r.cos }));
    }
    this._ftsRank(queryText, pool).forEach((r, i) => bump(r.id, (queryVec ? 1 - vectorWeight : 1) / (K + i + 1), { bm25: r.s }));

    const top = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
    if (!top.length) return [];
    const marks = top.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT id, path, kind, start_line, end_line, title, text FROM chunks WHERE id IN (${marks})`)
      .all(...top.map(([id]) => id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return top
      .map(([id, s]) => {
        const r = byId.get(id);
        if (!r) return null;
        const boost = r.kind === 'brain' ? 1.1 : 1; // notes in the "brain" folder get a small priority
        return {
          id, path: r.path, kind: r.kind, start: r.start_line, end: r.end_line, title: r.title, text: r.text,
          score: s.score * boost, cos: s.cos, bm25: s.bm25,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
  }

  // ---------------------------------------------------------------- memories
  addMemory(text) {
    const t = String(text).trim().slice(0, 1000);
    if (!t) throw new Error(tr('db.memEmpty'));
    const existing = this.listMemories().find((m) => norm(m.text) === norm(t));
    if (existing) return { ...existing, duplicate: true };
    const created = Date.now();
    const r = this.db.prepare('INSERT INTO memories(text, created_at, profile_id) VALUES(?,?,?)').run(t, created, this.profileId);
    const id = Number(r.lastInsertRowid);
    this.db.prepare('INSERT INTO memories_fts(rowid,text) VALUES(?,?)').run(id, t);
    return { id, text: t, created_at: created };
  }
  listMemories() {
    return this.db.prepare('SELECT id, text, created_at FROM memories WHERE profile_id = ? ORDER BY id DESC').all(this.profileId);
  }
  deleteMemory(id) {
    this.db.prepare('DELETE FROM memories_fts WHERE rowid IN (SELECT id FROM memories WHERE id = ? AND profile_id = ?)').run(id, this.profileId);
    return this.db.prepare('DELETE FROM memories WHERE id = ? AND profile_id = ?').run(id, this.profileId).changes > 0;
  }
  clearMemories() {
    this.db.prepare('DELETE FROM memories_fts WHERE rowid IN (SELECT id FROM memories WHERE profile_id = ?)').run(this.profileId);
    this.db.prepare('DELETE FROM memories WHERE profile_id = ?').run(this.profileId);
  }
  findMemories(needle) {
    const n = norm(needle);
    return this.listMemories().filter((m) => norm(m.text).includes(n));
  }
  searchMemories(query, k = 8) {
    const q = ftsQuery(query);
    if (!q) return [];
    try {
      const ids = this.db.prepare('SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?').all(q, k);
      return ids.map((r) => this.db.prepare('SELECT id, text, created_at FROM memories WHERE id = ? AND profile_id = ?').get(r.id, this.profileId)).filter(Boolean);
    } catch {
      return [];
    }
  }
}

module.exports = { BrainDB, norm, ftsQuery };
