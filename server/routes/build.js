// POST /build  { text?: string, words?: string[], lang?: string, force?: boolean }
//
// Refine-and-store on demand: the reader can post a word (or a chunk of text) and
// get back what was built. Reuses the same pipeline as the CLI. This is the
// read-through entry point — a miss in GET /define can be followed by POST /build
// to materialize the refined entry, after which /define serves it prebuilt.

import { Router } from 'express';
import { getDb } from '../db.js';
import { refineWords } from '../generate/build.js';

export const buildRouter = Router();

buildRouter.post('/build', async (req, res) => {
  const lang = String(req.body?.lang || 'en');
  const force = Boolean(req.body?.force);
  const fromText = typeof req.body?.text === 'string' ? req.body.text.split(/\s+/) : [];
  const fromWords = Array.isArray(req.body?.words) ? req.body.words : [];
  const words = [...fromWords, ...fromText].filter(Boolean);
  if (!words.length) return res.status(400).json({ error: 'text or words required' });

  try {
    const results = await refineWords({ db: getDb(), lang, words, force });
    const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
    res.json({ counts, results });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});
