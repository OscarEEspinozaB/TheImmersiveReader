// POST /build  { text?: string, words?: string[], lang?: string, force?: boolean }
//
// Refine-and-store on demand: the reader can post a word (or a chunk of text) and
// get back what was built. Reuses the same pipeline as the CLI. This is the
// read-through entry point — a miss in GET /define can be followed by POST /build
// to materialize the refined entry, after which /define serves it prebuilt.

import { Router } from 'express';
import { getDb } from '../db.js';
import { refineWords } from '../generate/build.js';
import { kbLog, KB_COLORS as C } from '../log.js';

export const buildRouter = Router();

// Map a per-word build result to a colored screen log so the read-through process
// is visible: BUILT (just stored), SEEDED (fetched from a public dictionary — how
// non-English books are built), SKIPPED (already refined), ABSENT/FAILED.
const RESULT_LOG = {
  refined: (r) => kbLog(C.green, 'BUILT', r.word, r.definition),
  seeded: (r) => kbLog(C.green, 'SEEDED', r.word, 'from a public dictionary'),
  skipped: (r) => kbLog(C.dim, 'SKIPPED', r.word, 'already refined'),
  absent: (r) => kbLog(C.dim, 'ABSENT', r.word, 'not in KB or any source'),
  failed: (r) => kbLog(C.red, 'FAILED', r.word, 'Ollama unreachable?'),
};

buildRouter.post('/build', async (req, res) => {
  const lang = String(req.body?.lang || 'en');
  const force = Boolean(req.body?.force);
  const fromText = typeof req.body?.text === 'string' ? req.body.text.split(/\s+/) : [];
  const fromWords = Array.isArray(req.body?.words) ? req.body.words : [];
  const words = [...fromWords, ...fromText].filter(Boolean);
  if (!words.length) return res.status(400).json({ error: 'text or words required' });

  try {
    const results = await refineWords({
      db: getDb(),
      lang,
      words,
      force,
      onStart: (word) => kbLog(C.blue, 'BUILDING', word, 'refining with Ollama…'),
      onResult: (r) => RESULT_LOG[r.status]?.(r),
    });
    const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
    res.json({ counts, results });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});
