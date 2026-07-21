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

-- One row per inflected form of an entry. The part of speech is what makes a form
-- MEAN something: "cats" is the plural of the NOUN cat and the third-person
-- singular of the VERB cat, and without it the dump's verb paradigm gets pinned on
-- the noun's plural (the reader then reads "cats: third-person singular of cat",
-- which is simply false).
-- The curated flag marks a hand-written row from server/paradigms.js: the ~90
-- forms of the pronouns, BE/HAVE/DO and the modals. They are the highest-frequency
-- words a learner meets, the dump gets them wrong (its BE table omits "am" and
-- offers "wast"/"weren"; its "it" lists "they"/"them" as forms of it), and a
-- curated row always wins over a dumped one.
CREATE TABLE IF NOT EXISTS inflections (
  entry_id TEXT NOT NULL REFERENCES entries(id),
  pos      TEXT NOT NULL,          -- "verb" | "noun" | "adj" | "adv" | "pron" | "det"
  tag      TEXT NOT NULL,          -- "past" | "past participle" | "plural" | "comparative" | ...
  form     TEXT NOT NULL,          -- "ran", "running", "mice", "better", ...
  curated  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entry_id, pos, tag, form)
);
CREATE INDEX IF NOT EXISTS idx_inflections_form ON inflections(form);

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

-- Words asked of the external gap-fill (generate/gapfill.js) that no public
-- dictionary had. Two jobs:
--   1. Stop re-asking. A Harry Potter build hits ~150 of these per book (Gringotts,
--      Quirrell, Hagrid's "yeh'll", stutters like "bbook"); without this every
--      rebuild would spend the same network round trips to learn the same nothing.
--   2. Be reviewable. This is the "not processed" list — mostly proper nouns and
--      dialect spellings, i.e. exactly the words a reader may want to mark
--      Discarded. It NEVER sets that state itself: Discarded is manual-only, and
--      never inferred from a missing dictionary entry (the red-sea invariant).
CREATE TABLE IF NOT EXISTS gapfill_misses (
  lang     TEXT NOT NULL,
  word     TEXT NOT NULL,
  tried_at INTEGER NOT NULL,
  tries    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (lang, word)
);
CREATE INDEX IF NOT EXISTS idx_gapfill_misses_lang ON gapfill_misses(lang);

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
-- Refined rows are keyed by LEMMA: an inflected form has no entry of its own, it
-- is served its lemma's (see generate/build.js). The rev column is the contract the
-- row was written under (generate/ollama.js#REFINE_REV) — it is what lets the
-- kb:audit script tell an entry that is merely OLD from one that is WRONG.
CREATE TABLE IF NOT EXISTS refined (
  entry_id     TEXT PRIMARY KEY REFERENCES entries(id),
  definition   TEXT NOT NULL,
  synonyms     TEXT NOT NULL DEFAULT '[]',  -- JSON array
  antonyms     TEXT NOT NULL DEFAULT '[]',  -- JSON array
  model        TEXT,
  rev          INTEGER NOT NULL DEFAULT 1,
  generated_at INTEGER NOT NULL
);
`;

/** The KB schema version stamped on each entry (for later batch migrations). */
export const KB_SCHEMA_VERSION = 1;

// The first `inflections` table had no `pos` column and only ever held the four
// verb-tense tags, so every plural/comparative was missing and every noun plural
// was mislabelled as a verb form. The data is fully re-derivable from the dump
// (`npm run ingest:forms`), and the old rows are wrong, so the migration drops
// them rather than trying to guess a part of speech for each one.
function migrate(conn) {
  const cols = conn.prepare("SELECT name FROM pragma_table_info('inflections')").all();
  if (cols.length && !cols.some((c) => c.name === 'pos')) {
    conn.exec('DROP TABLE inflections');
    console.warn('KB: dropped the pre-POS inflections table — run `npm run ingest:forms` to rebuild it.');
  }
  // Existing refined rows predate the contract stamp: they are rev 1 by definition,
  // which is exactly what the DEFAULT says, so adding the column is the whole
  // migration — `kb:audit` picks them up from there.
  const refinedCols = conn.prepare("SELECT name FROM pragma_table_info('refined')").all();
  if (refinedCols.length && !refinedCols.some((c) => c.name === 'rev')) {
    conn.exec('ALTER TABLE refined ADD COLUMN rev INTEGER NOT NULL DEFAULT 1');
  }
}

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
  migrate(db);
  db.exec(SCHEMA);
  return db;
}

export { DB_PATH };
