// Per-user vocabulary sync (the core of the home server).
//
//   GET   /vocab?user=&since=   -> entries changed since a timestamp (pull)
//   PUT   /vocab                -> bulk upsert a batch of changes (push)
//   PATCH /vocab                -> upsert a single change
//
// Conflict resolution is last-write-wins by `updatedAt`: an incoming change is
// applied only if it is newer than the stored one, so two devices editing the same
// (user, lang, word) converge on the most recent edit. A state of "unknown" is a
// tombstone (the word was reverted to the default) and is stored/propagated so the
// revert reaches other devices; clients delete it from their local store on pull.

import { Router } from 'express';
import { getLibraryDb } from '../library-db.js';

export const vocabRouter = Router();

const STATES = new Set(['unknown', 'learning', 'known']);

// Upsert one change, last-write-wins. Returns true if it was applied (newer).
function upsert(db, user, e) {
  if (!e || typeof e.word !== 'string' || typeof e.lang !== 'string') return false;
  if (!STATES.has(e.state)) return false;
  const updatedAt = Number(e.updatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  const info = db
    .prepare(
      `INSERT INTO vocabulary (user, lang, word, state, updated_at)
       VALUES (@user, @lang, @word, @state, @updatedAt)
       ON CONFLICT(user, lang, word) DO UPDATE SET
         state = excluded.state,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at > vocabulary.updated_at`,
    )
    .run({ user, lang: e.lang, word: e.word, state: e.state, updatedAt });
  return info.changes > 0;
}

vocabRouter.get('/vocab', (req, res) => {
  const user = String(req.query.user || '').trim();
  if (!user) return res.status(400).json({ error: 'Missing user.' });
  const since = Number(req.query.since) || 0;

  const rows = getLibraryDb()
    .prepare('SELECT lang, word, state, updated_at FROM vocabulary WHERE user = ? AND updated_at > ?')
    .all(user, since);
  res.json({
    now: Date.now(),
    entries: rows.map((r) => ({ lang: r.lang, word: r.word, state: r.state, updatedAt: r.updated_at })),
  });
});

vocabRouter.put('/vocab', (req, res) => {
  const user = String(req.body?.user || '').trim();
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
  if (!user || !entries) return res.status(400).json({ error: 'Expected { user, entries: [...] }.' });

  const db = getLibraryDb();
  let applied = 0;
  const tx = db.transaction((list) => {
    for (const e of list) if (upsert(db, user, e)) applied += 1;
  });
  tx(entries);
  res.json({ applied, now: Date.now() });
});

vocabRouter.patch('/vocab', (req, res) => {
  const user = String(req.body?.user || '').trim();
  if (!user) return res.status(400).json({ error: 'Missing user.' });
  const applied = upsert(getLibraryDb(), user, req.body) ? 1 : 0;
  res.json({ applied, now: Date.now() });
});
