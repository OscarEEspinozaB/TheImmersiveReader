// Per-user reading position sync: resume a book at the same spot on another device.
//
//   GET /position?user=&book=    -> { paragraph, word, updatedAt } for one book (or {})
//   GET /position?user=&since=   -> { now, positions:[...] } changed since a timestamp
//   PUT /position                -> bulk upsert { user, positions:[{ book, ... }] }
//
// The book is keyed by its NORMALIZED TITLE (the client sends it already normalized):
// the local book id is device-specific, the title is what two devices share. Conflict
// resolution is last-write-wins by `updatedAt`, exactly like /vocab — the newest
// reader position wins, so the device you read on most recently is the one that leads.

import { Router } from 'express';
import { getLibraryDb } from '../library-db.js';
import { kbLog, KB_COLORS as C } from '../log.js';

export const positionRouter = Router();

// Upsert one position, last-write-wins. Returns true if it was applied (newer).
function upsert(db, user, p) {
  if (!p || typeof p.book !== 'string' || !p.book) return false;
  const paragraph = Number(p.paragraph);
  const word = Number(p.word);
  const updatedAt = Number(p.updatedAt);
  if (!Number.isFinite(paragraph) || !Number.isFinite(word) || !Number.isFinite(updatedAt)) return false;
  const info = db
    .prepare(
      `INSERT INTO reading_position (user, book, paragraph, word, updated_at)
       VALUES (@user, @book, @paragraph, @word, @updatedAt)
       ON CONFLICT(user, book) DO UPDATE SET
         paragraph = excluded.paragraph,
         word = excluded.word,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at > reading_position.updated_at`,
    )
    .run({ user, book: p.book, paragraph: paragraph | 0, word: word | 0, updatedAt });
  return info.changes > 0;
}

positionRouter.get('/position', (req, res) => {
  const user = String(req.query.user || '').trim();
  if (!user) return res.status(400).json({ error: 'Missing user.' });
  const db = getLibraryDb();

  // One book: the hot path when opening a book on a device.
  const book = String(req.query.book || '').trim();
  if (book) {
    const row = db
      .prepare('SELECT paragraph, word, updated_at FROM reading_position WHERE user = ? AND book = ?')
      .get(user, book);
    kbLog(
      C.blue,
      'POS·GET',
      user,
      row
        ? `book="${book}" paragraph=${row.paragraph} word=${row.word}`
        : `book="${book}" → none stored`,
    );
    return res.json(row ? { paragraph: row.paragraph, word: row.word, updatedAt: row.updated_at } : {});
  }

  // Incremental pull of everything changed since a timestamp.
  const since = Number(req.query.since) || 0;
  const rows = db
    .prepare('SELECT book, paragraph, word, updated_at FROM reading_position WHERE user = ? AND updated_at > ?')
    .all(user, since);
  res.json({
    now: Date.now(),
    positions: rows.map((r) => ({ book: r.book, paragraph: r.paragraph, word: r.word, updatedAt: r.updated_at })),
  });
});

positionRouter.put('/position', (req, res) => {
  const user = String(req.body?.user || '').trim();
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : null;
  if (!user || !positions) return res.status(400).json({ error: 'Expected { user, positions: [...] }.' });

  const db = getLibraryDb();
  let applied = 0;
  const tx = db.transaction((list) => {
    for (const p of list) {
      const ok = upsert(db, user, p);
      if (ok) applied += 1;
      kbLog(
        ok ? C.green : C.yellow,
        ok ? 'POS·SET' : 'POS·STALE',
        user,
        `book="${p?.book}" paragraph=${p?.paragraph} word=${p?.word}` +
          (ok ? '' : ' → ignored (older)'),
      );
    }
  });
  tx(positions);
  res.json({ applied, now: Date.now() });
});
