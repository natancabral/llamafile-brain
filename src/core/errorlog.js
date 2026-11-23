'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('./sqlite');

/**
 * Persistent log of files the indexer could not (fully) index: too large, unreadable, no text...
 * Lives in its own SQLite file (errors.sqlite) so it never touches the knowledge database, and every
 * method swallows its own errors: logging a problem must never break indexing.
 * One row per (path, kind); a repeated problem only refreshes the row.
 */
class ErrorLog {
  constructor(file) {
    this.file = file;
    this.db = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.db = openDatabase(file);
      this.db.exec(`CREATE TABLE IF NOT EXISTS errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        size INTEGER,
        lim INTEGER,
        detail TEXT,
        ts INTEGER NOT NULL,
        UNIQUE(path, kind)
      )`);
    } catch {
      this.db = null;
    }
  }

  add({ path: p, kind, size = null, limit = null, detail = '' }) {
    try {
      this.db?.prepare(
        `INSERT INTO errors(path, kind, size, lim, detail, ts) VALUES(?,?,?,?,?,?)
         ON CONFLICT(path, kind) DO UPDATE SET size = excluded.size, lim = excluded.lim, detail = excluded.detail, ts = excluded.ts`,
      ).run(p, kind, size, limit, String(detail || '').slice(0, 300), Date.now());
    } catch {
      /* ignore */
    }
  }

  /** The file is fine now (indexed, or no longer a problem): drop its rows. */
  resolve(p) {
    try {
      this.db?.prepare('DELETE FROM errors WHERE path = ?').run(p);
    } catch {
      /* ignore */
    }
  }

  /** Removes rows of files that no longer exist. */
  pruneMissing() {
    try {
      for (const r of this.db?.prepare('SELECT DISTINCT path FROM errors').all() || []) {
        if (!fs.existsSync(r.path)) this.resolve(r.path);
      }
    } catch {
      /* ignore */
    }
  }

  list(limit = 500) {
    try {
      return (this.db?.prepare('SELECT id, path, kind, size, lim AS "limit", detail, ts FROM errors ORDER BY ts DESC LIMIT ?').all(limit) || []).map((r) => ({ ...r }));
    } catch {
      return [];
    }
  }

  count() {
    try {
      return Number(this.db?.prepare('SELECT COUNT(*) n FROM errors').get().n) || 0;
    } catch {
      return 0;
    }
  }

  clear() {
    try {
      this.db?.exec('DELETE FROM errors');
    } catch {
      /* ignore */
    }
  }

  close() {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
    this.db = null;
  }
}

module.exports = { ErrorLog };
