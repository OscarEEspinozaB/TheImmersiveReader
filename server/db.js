// SQLite connection + schema for the local dictionary knowledge base (KB).
//
// The KB is a single-user, local, read-through service on the LAN. Storage is a
// single SQLite file (data/dictionary.sqlite), trivial to back up and to carry to
// another machine. The schema is multilingual by construction — `lang` lives on
// every entry and on `translations.target_lang` — even though milestone 1–3 only
// populates English.
//
// This milestone WRITES entries/senses/inflections/relations (all from the
// offline Kaikki dump). translations/provenance/generation_progress are created
// now so later milestones (LLM gap-fill, re-refine, EN→ES translation) don't need
// a schema migration.

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo-root/data/dictionary.sqlite (server/ is a sibling of data/).
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = process.env.KB_DB_PATH || join(DATA_DIR, 'dictionary.sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id        TEXT PRIMARY KEY,      -- \`\${lang}:\${word}\`, e.g. "en:run"
  lang      TEXT NOT NULL,
  word      TEXT NOT NULL,         -- normalized lemma (normalize() from src/)
  pos       TEXT,                  -- JSON array of parts of speech
  schema_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_lang ON entries(lang);

CREATE TABLE IF NOT EXISTS inflections (
  entry_id TEXT NOT NULL REFERENCES entries(id),
  tag      TEXT NOT NULL,          -- "past" | "past participle" | "present participle" | ...
  form     TEXT NOT NULL,          -- "ran", "running", ...
  PRIMARY KEY (entry_id, tag, form)
);

CREATE TABLE IF NOT EXISTS senses (
  id        INTEGER PRIMARY KEY,
  entry_id  TEXT NOT NULL REFERENCES entries(id),
  definition TEXT NOT NULL,
  example    TEXT,
  ord        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_senses_entry ON senses(entry_id);
-- A Wiktextract dump repeats the same gloss across split etymology/line entries,
-- so dedupe a definition per word: INSERT OR IGNORE skips the repeats at ingest.
CREATE UNIQUE INDEX IF NOT EXISTS idx_senses_unique ON senses(entry_id, definition);

CREATE TABLE IF NOT EXISTS relations (
  from_sense INTEGER NOT NULL REFERENCES senses(id),
  to_word    TEXT NOT NULL,
  type       TEXT NOT NULL,        -- "synonym" | "antonym" | "related"
  PRIMARY KEY (from_sense, to_word, type)
);

CREATE TABLE IF NOT EXISTS translations (
  sense_id    INTEGER NOT NULL REFERENCES senses(id),
  target_lang TEXT NOT NULL,
  text        TEXT NOT NULL,
  PRIMARY KEY (sense_id, target_lang, text)
);

CREATE TABLE IF NOT EXISTS provenance (
  entry_id   TEXT NOT NULL REFERENCES entries(id),
  field_path TEXT NOT NULL,
  source     TEXT NOT NULL,        -- "offline-dataset" | "dictionary-api" | "ai" | "manual"
  source_name TEXT,
  generated_at INTEGER NOT NULL,
  locked     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entry_id, field_path)
);

CREATE TABLE IF NOT EXISTS generation_progress (
  lang   TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL, total INTEGER NOT NULL,
  status TEXT NOT NULL,            -- "running" | "paused" | "done" | "error"
  started_at INTEGER
);

-- AI-refined "clean" view of an entry, built once from the raw Kaikki data: a
-- single simple-English definition plus curated synonyms/antonyms. Stored beside
-- (not over) the raw senses so a re-refine can replace it without losing the
-- offline source, and /define serves it as the primary definition when present.
CREATE TABLE IF NOT EXISTS refined (
  entry_id     TEXT PRIMARY KEY REFERENCES entries(id),
  definition   TEXT NOT NULL,
  synonyms     TEXT NOT NULL DEFAULT '[]',  -- JSON array
  antonyms     TEXT NOT NULL DEFAULT '[]',  -- JSON array
  model        TEXT,
  generated_at INTEGER NOT NULL
);
`;

/** The KB schema version stamped on each entry (for later batch migrations). */
export const KB_SCHEMA_VERSION = 1;

let db = null;

/** Open (once) the SQLite connection and ensure the schema exists. */
export function getDb() {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  // Let the batch builder and the server share the file: wait (don't error) up to
  // 5s if the other process holds the write lock for a moment.
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

export { DB_PATH };
