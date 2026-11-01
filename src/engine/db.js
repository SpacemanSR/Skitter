'use strict';
/* SQLite store (node:sqlite, built into Electron's Node — no native module).
   docs + full-text index + text chunks with int8 vectors + opens history + proposals with features. */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 4;

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON;');
  db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
  const ver = Number((db.prepare("SELECT v FROM meta WHERE k='schema'").get() || {}).v || 0);
  if (ver !== SCHEMA_VERSION) {
    db.exec(`
      DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS fts_v; DROP TABLE IF EXISTS fts; DROP TABLE IF EXISTS docs;
      CREATE TABLE docs (
        id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, nname TEXT, ext TEXT, dir TEXT, content INTEGER NOT NULL DEFAULT 1,
        mtime INTEGER, size INTEGER, len INTEGER, embedded INTEGER NOT NULL DEFAULT 0, indexed_at INTEGER);
      CREATE INDEX IF NOT EXISTS docs_mtime ON docs(mtime);
      CREATE INDEX IF NOT EXISTS docs_embedded ON docs(embedded, mtime);
      CREATE VIRTUAL TABLE fts USING fts5(name, body, tokenize='unicode61 remove_diacritics 0');
      CREATE VIRTUAL TABLE fts_v USING fts5vocab(fts, 'row');
      CREATE TABLE chunks (id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE, idx INTEGER, text TEXT, vec BLOB);
      CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id);
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS opens (path TEXT NOT NULL, ts INTEGER NOT NULL, src TEXT);
      CREATE INDEX IF NOT EXISTS opens_ts ON opens(ts);
      CREATE INDEX IF NOT EXISTS opens_path ON opens(path, ts);
      CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, ts INTEGER, mode TEXT, path TEXT, prob REAL, features TEXT, ctx TEXT, outcome TEXT, outcome_ts INTEGER);
      CREATE INDEX IF NOT EXISTS proposals_path ON proposals(path);
    `);
    db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
  }
  return db;
}

function getMeta(db, k, dflt) { const r = db.prepare('SELECT v FROM meta WHERE k=?').get(k); if (!r) return dflt; try { return JSON.parse(r.v); } catch (e) { return dflt; } }
function setMeta(db, k, v) { db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(k, JSON.stringify(v)); }

function tx(db, fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }

module.exports = { open, getMeta, setMeta, tx, SCHEMA_VERSION };
