'use strict';

const { t: tr } = require('../shared/i18n');

/**
 * Opens a SQLite database using the built-in `node:sqlite` module
 * (available in Node >= 22.5 and Electron >= 37, with FTS5 enabled).
 * No native add-on to compile.
 */
function openDatabase(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    throw new Error(`${tr('sqlite.missing')} ${e.message}`);
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  return db;
}

module.exports = { openDatabase };
