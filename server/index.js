// The Immersive Reader — local dictionary KB service (LAN).
//
// A small Express app on the home machine that serves the offline dictionary over
// the LAN, so every device on the network reads the same KB with zero per-device
// setup. Milestone 1–3: read-only /define backed by SQLite (seeded from a Kaikki
// dump). Later milestones add /admin/{generate,refine,translate} (LLM, behind the
// same process).
//
// The same process also hosts the home book LIBRARY (/books): upload a processed
// `.tir` from one device, browse and download it from another. Books live in a
// separate SQLite file + blob dir (library-db.js); no accounts yet (trusted LAN).

import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { defineRouter } from './routes/define.js';
import { buildRouter } from './routes/build.js';
import { wordsRouter } from './routes/words.js';
import { statsRouter } from './routes/stats.js';
import { booksRouter } from './routes/books.js';
import { vocabRouter } from './routes/vocab.js';
import { positionRouter } from './routes/position.js';
import { aiDefineRouter } from './routes/aiDefine.js';
import { getLibraryDb } from './library-db.js';

const PORT = Number(process.env.KB_PORT || 4321);

const app = express();
// The reader runs from the Vite dev server and from the LAN IP; allow all origins
// — this is a single-user service on a trusted home network, not a public API.
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(defineRouter);
app.use(buildRouter);
app.use(wordsRouter);
app.use(statsRouter);
app.use(booksRouter);
app.use(vocabRouter);
app.use(positionRouter);
app.use(aiDefineRouter);

getDb(); // open the connection + ensure schema before accepting requests
getLibraryDb(); // open the library DB + ensure its schema/dirs exist

app.listen(PORT, () => {
  console.log(`Dictionary KB + library service listening on http://0.0.0.0:${PORT}`);
});
