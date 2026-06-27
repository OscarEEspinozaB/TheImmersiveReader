// The Immersive Reader — local dictionary KB service (LAN).
//
// A small Express app on the home machine that serves the offline dictionary over
// the LAN, so every device on the network reads the same KB with zero per-device
// setup. Milestone 1–3: read-only /define backed by SQLite (seeded from a Kaikki
// dump). Later milestones add /admin/{generate,refine,translate} (LLM, behind the
// same process).

import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { defineRouter } from './routes/define.js';
import { buildRouter } from './routes/build.js';
import { wordsRouter } from './routes/words.js';
import { statsRouter } from './routes/stats.js';

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

getDb(); // open the connection + ensure schema before accepting requests
app.listen(PORT, () => {
  console.log(`Dictionary KB service listening on http://0.0.0.0:${PORT}`);
});
