# The Immersive Reader — Home Server (implemented)

One Node process (`npm run server`, Express, port `4321`) on the home machine
serves three things over the LAN: the **dictionary knowledge base**, the **book
library**, and the **per-profile learning data** (vocabulary sync + shared AI
explanations). Every device on the network reads the same data with zero
per-device setup. Future work (accounts, age gating, progress sync, OPDS) lives in
[vision.md](vision.md) §5.

Design stance: the server is a **thin authority**. Ingestion (PDF/EPUB → clean
text) stays on the client; books arrive already processed as `.tir` archives.
There are no accounts yet — a trusted home LAN and a lightweight profile name.
CORS is open on purpose (single-household service, not a public API).

## 1. Layout & storage

```text
server/
  index.js          Express app: mounts all routers, opens both DBs
  db.js             dictionary KB SQLite (data/dictionary.sqlite) + schema
  library-db.js     library SQLite (data/library.sqlite) + schema + books blob dir
  lemma.js          formOf() (inflected form → lemma) and verbForms() (tense paradigm)
  log.js            colored per-request console log (HIT/MISS/BUILDING/BUILT…)
  routes/           define, build, words, stats, books, vocab, aiDefine
  generate/         ollama.js (refine), build.js (refine-and-store pipeline),
                    explain.js (context AI), book.js (batch CLI), run.js (text CLI)
  ingest/           kaikki.js (Wiktextract JSONL → KB), pdfText.js, run.js (CLI)
data/               gitignored: dictionary.sqlite, library.sqlite, books/ (blobs),
                    kaikki-<lang>.jsonl (user-dropped dump)
```

Both DBs run WAL with a 5 s busy timeout so the server and a batch CLI can share
them. The server imports `src/normalize.js` and `src/words.js` directly — one
implementation of word keying and segmentation for browser and Node, so KB keys
(`<lang>:<word>`) always match what the reader makes clickable.

Env vars: `KB_PORT`, `KB_DB_PATH`, `LIBRARY_DB_PATH`, `LIBRARY_BOOKS_DIR`,
`KB_OLLAMA_URL` (default `http://localhost:11434`), `KB_REFINE_MODEL`,
`KB_EXPLAIN_MODEL` (default `gemma4:e2b`), `KAIKKI_FILE`.

## 2. Dictionary knowledge base

The KB holds deterministic linguistic data seeded from a **Kaikki.org /
Wiktextract** dump, plus an AI-**refined** layer built on top of it.

- **Schema** (`db.js`): `entries` (id `<lang>:<word>`, POS), `senses` (glosses,
  deduped per word), `inflections` (verb-tense forms; archaic/obsolete/dialectal
  qualifiers rejected at ingest), `relations` (synonym/antonym graph),
  `refined` (one simple-English definition + curated synonyms/antonyms + model),
  `provenance` (per-field source stamping with a `locked` guard), and
  `translations`/`generation_progress` (created, not yet populated — see vision).
- **Ingest** (`npm run ingest:en`): streams the JSONL line-by-line, batched
  transactions, merges POS across a word's split entries, skips multi-word
  phrases. Runs in minutes, zero LLM.
- **Refinement** (`generate/ollama.js` + `build.js`): Ollama (`format: "json"`)
  condenses a word's raw senses into ONE clear, simple-English definition plus at
  most 6 synonyms/antonyms. It never overwrites the raw data, so re-running with
  a stronger model (`--model … --force`) is safe. Inflected forms are linked to
  their lemma (`formOf`) and the definition must open with that link
  ("Past tense of 'come': …").
- **Read-through**: a `/define` miss on the refined layer can be followed by a
  client-triggered `POST /build` that refines and stores the word in the
  background; the next lookup is prebuilt. Words truly absent from the dump
  report `absent` and stay on the on-demand chain.
- **Batch CLI** (`npm run build:book -- "<file>" --batch 500`): extracts a whole
  book's unique words **in reading order** (or `--by-frequency`) and refines the
  next N pending ones per run; resumable because every entry commits
  immediately. `--model`/`--force` re-refines with a stronger model.

## 3. Book library

`.tir` archives (built client-side by `src/tir.js`) are POSTed raw; the server
reads title/lang/cover from the archive's own `manifest.json` (fflate) — no
separate metadata payload. Metadata lives in the `books` table; payloads and
covers live as plain files under `data/books/`. Books are immutable; re-uploads
dedupe by the manifest's stable book id (sha256 of the bytes as fallback for
legacy files). Downloads stream the `.tir` back with a proper filename.

## 4. Vocabulary sync

The `vocabulary` table is keyed `(user, lang, word)` where `user` is the profile
name from Settings. Conflict resolution is **last-write-wins by `updated_at`**;
a state of `unknown` is a stored tombstone so reverts propagate to other
devices. The client (`src/vocabSync.js`) is offline-first: every local edit is
queued (debounced) and pushed; pulls are incremental (`since` timestamp) on
startup and tab focus. A wiped browser is repopulated from the server on the
next load.

## 5. Context-aware AI explanations (shared cache)

The reader no longer calls Ollama directly for explanations — it POSTs to the
server, which serves a stored answer when present and only calls the LLM on a
miss (`ai_definitions` table). The **sentence is the cache identity** (the
visual page is not): the key hashes prompt version + book + lang + kind + native
language + word + sentence + model, so one generation serves every device, and
switching models in Settings gets a fresh answer instead of reusing another
model's. Concurrent identical requests coalesce onto a single generation.

Two kinds: `explain` (simple terms of the reading language) and `native` (the
user's language, translation-first). Prompts are **grounded with the KB's real
verb paradigm** (`lemma.js#verbForms`) so a small local model doesn't hallucinate
inflections; when the data is ambiguous the tag is omitted rather than asserted.

`GET /ai/health` powers the reader's "Ask AI" button visibility; `GET /ai/models`
feeds the Settings model picker from the server's installed Ollama models.

## 6. API surface

```text
GET    /health                          liveness
GET    /define?word=&lang=              KB entry (refined + raw senses + formOf); 404 on miss
POST   /build   {words|text, lang, force}   refine-and-store (read-through)
GET    /words?lang=&q=&sort=&limit=     built (refined) words, for the Dictionary hub
GET    /stats?lang=                     dictionary-data stats card
GET    /books?lang=&q=                  catalog        POST /books        upload .tir (raw bytes)
GET    /books/:id | /content | /cover   metadata / download / cover      DELETE /books/:id
GET    /vocab?user=&since=              pull           PUT /vocab (bulk) · PATCH /vocab (single)
POST   /ai/define                       explain in reading language (cached)
POST   /ai/explain                      explain in native language (cached)
GET    /ai/health · /ai/models          Ollama probe · installed models
```

## 7. Client integration

- `src/definitions/kbApi.js` — `/define` in the quick chain (after the local
  dict, before dictionaryapi.dev), `/words`, `/stats`, background `/build`.
- `src/definitions/serverAi.js` — `/ai/*`; replaces the old direct Ollama calls.
- `src/serverLibrary.js` + `src/serverShelf.js` — the **Server** hub view:
  browse the catalog, download into the local library, upload from the shelf's
  ☁ button.
- `src/vocabSync.js` — vocabulary push/pull, wired through `vocabulary.js`
  (`onChange` / `applyRemoteEntry`).
- One setting (`Home server` URL, default `http://192.168.100.6:4321`) turns the
  whole integration on; away from the LAN every call fails soft and the app
  falls back to its local, offline behavior.

## 8. Running on the LAN

```bash
npm run server          # http://<machine-ip>:4321 (binds all interfaces)
npm run dev             # Vite client, also LAN-exposed (host: true, port 5173)
```

Find the machine's IP with `hostname -I`. If another device can't reach either
port: same WiFi/LAN, router "client isolation" off, and open the ports in the
host firewall (`sudo ufw allow 5173/tcp`, `… 4321/tcp`). For the optional AI
features, Ollama only needs to be reachable **from the server process**
(localhost by default) — phones never talk to Ollama directly anymore.
