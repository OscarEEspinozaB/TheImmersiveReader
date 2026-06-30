// SQLite connection + schema for the home book LIBRARY (separate from the
// dictionary KB). One household, a handful of devices: a single SQLite file
// (data/library.sqlite) holds the catalog metadata, and the heavy book payloads
// (the `.tir` archives + cover thumbnails) live as plain files under data/books/,
// referenced by id — keeping the DB small and trivially backed up (copy the file
// + the books dir).
//
// No accounts in this milestone: a book store open on the trusted home LAN, so any
// device can upload a processed `.tir` and any other device can download it.

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = process.env.LIBRARY_DB_PATH || join(DATA_DIR, 'library.sqlite');

/** Where the `.tir` payloads and cover blobs are stored on disk. */
export const BOOKS_DIR = process.env.LIBRARY_BOOKS_DIR || join(DATA_DIR, 'books');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS books (
  id            TEXT PRIMARY KEY,     -- server-side uuid
  book_uid      TEXT,                 -- the book's STABLE identity (.tir manifest id)
  sha           TEXT NOT NULL,        -- sha256 of the .tir bytes (fallback dedup)
  title         TEXT,
  author        TEXT,
  lang          TEXT,                 -- the book's reading (learning) language
  size          INTEGER NOT NULL,     -- .tir byte size
  cover_mime    TEXT,                 -- null when the book has no cover
  book_added_at INTEGER,              -- original addedAt from the .tir manifest
  uploaded_at   INTEGER NOT NULL      -- when the server received it
);

-- Per-user vocabulary progress (the core sync). 'user' is a lightweight profile
-- name (no password yet — trusted LAN). 'state' is learning|known; an 'unknown'
-- row is a tombstone (a word reverted to the default) so the revert propagates to
-- other devices. Last-write-wins by updated_at.
CREATE TABLE IF NOT EXISTS vocabulary (
  user        TEXT NOT NULL,
  lang        TEXT NOT NULL,          -- learning language; scopes the word
  word        TEXT NOT NULL,          -- normalized (lowercased, punctuation stripped)
  state       TEXT NOT NULL,          -- unknown | learning | known
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user, lang, word)
);
`;

// Indexes are created AFTER the migration, since idx_books_uid references a column
// that an older library.sqlite may not have yet.
// The same logical book (same manifest id) maps to ONE row, even if re-exported
// with slightly different bytes; sha is a fallback for legacy files without an id.
const INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_books_uid ON books(book_uid) WHERE book_uid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_books_sha ON books(sha);
CREATE INDEX IF NOT EXISTS idx_books_lang ON books(lang);
-- Pulling a user's changes since a timestamp is the hot path for sync.
CREATE INDEX IF NOT EXISTS idx_vocab_pull ON vocabulary(user, updated_at);
`;

// Add the book_uid column to a library.sqlite created before it existed.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(books)').all();
  if (!cols.some((c) => c.name === 'book_uid')) {
    db.exec('ALTER TABLE books ADD COLUMN book_uid TEXT');
  }
}

let db = null;

/** Open (once) the library SQLite connection and ensure the schema + dirs exist. */
export function getLibraryDb() {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(BOOKS_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  db.exec(INDEXES);
  return db;
}

export { DB_PATH as LIBRARY_DB_PATH };
