# The Immersive Reader — Vision (the one future-plans document)

> This is the **only** document that describes future work. Every other document in
> this repository describes what is actually implemented. When something here gets
> built, move its description into the matching implemented doc and delete it from
> this file. Last consolidated 2026-07-02 (absorbed `idea.md`, `ES_Ideas_Futuras/*`,
> and the pending sections of the old design docs).

## 1. North star

The product goal stays what it always was: read real books in a language you are
learning, watch the "red sea" of unknown words fade as your vocabulary grows, and
get explanations that meet you at your level. The single most important future
capability is:

- **Explanations constrained to words the user already knows.** No training or
  fine-tuning — pass the user's known-words list into the prompt (in-context) and
  instruct the model to explain using only those words. This makes explanations
  progressively easier as the vocabulary grows, closing the product's core loop.
  **Gated by hardware, not desire** (owner's call, 2026-07-02): honoring a long
  known-words constraint reliably needs a stronger model than the home CPU runs
  comfortably today. Revisit when the local hardware (or small-model quality)
  catches up.

## 2. Decided architecture direction

The client/server split already happened (see [home-server.md](home-server.md)) and
settled the old open question:

- **The server is Node + SQLite on the home LAN.** The earlier Phase-2 sketch
  (Rust backend, centralized PostgreSQL, Ollama cluster) is **retired**. It only
  becomes relevant again if the system ever leaves the LAN for the public internet
  or grows past one household — at that point it is a rewrite with real auth and
  real verification, not an increment.
- **Ingestion stays on the client.** The server receives processed `.tir` books,
  never raw PDFs/EPUBs. This keeps it thin and format-agnostic.
- **Packaging:** PWA remains the target for "install on a phone"; Tauri 2 (native
  desktop/mobile shell over the same web codebase) is the fallback if PWA-on-LAN
  keeps not holding up. Both reuse the codebase as-is.

## 3. Reader

- **Voice (old milestone M3) — the remaining part.** Word, word+definition and
  paragraph read-aloud already exist (`src/speech.js` via the bubbles and the
  Dictionary hub). What remains is **continuous read-aloud**: speak page after
  page with the words highlighted as they are spoken, first-class in paged mode.
  (Today the continuous reading mode exists partly so an *external* read-aloud
  tool can see the whole text.)
- **Sentence-level rescue** (much later — owner, 2026-07-02): a "translate this
  sentence" action, server-brokered and cached like the word explanations, for
  the moments the words are known but the sentence still doesn't parse.
- **PWA (old milestone M4).** `vite-plugin-pwa` (manifest + service worker) was
  tried and reverted: installability over plain HTTP on the LAN required a
  locally-trusted certificate per device and the result didn't behave like a real
  installable app. Revisit with a concrete plan (likely: serve the client over
  HTTPS from the home server with a self-signed CA installed once per device).

## 4. Dictionary knowledge base (server)

The KB serves refined English entries today. Still pending from the original
design (schema support already exists where noted):

- **Translations.** Per-sense translations into the user's native language
  (EN→ES first). The `translations` table already exists (keyed by `sense_id`,
  `target_lang` — open to N languages); what's missing is the generation pass
  (a purpose-built model such as `translategemma`, run as a separate batch) and
  surfacing translations in the popup/Dictionary hub.
- **Field locking + manual edits.** Provenance rows are already stamped (with a
  `locked` guard in SQL), but nothing sets `locked = 1` yet: there is no UI to
  edit an entry by hand. The contract to build: a manual edit locks that field
  forever; re-refine passes only touch `ai`-sourced, unlocked fields; a pin icon
  marks locked fields in the Dictionary hub.
- **Unattended batch generation.** Today batch building is a foreground CLI
  (`npm run build:book`). The original plan's nightly, resumable, thermally
  guarded job (write `generation_progress` — the table exists —, poll
  `lm-sensors`, pause above ~80 °C, run under `nice`/`ionice`) is still worth
  building for whole-library runs, because CPU inference on the home machine is
  ~5–25 s per word.
- **Portable KB export (`.tirdict`).** A zip (manifest + streamed NDJSON of
  entries) per language, mirroring the `.tir` book format, so a generated KB can
  be carried to a machine that never talks to the server. Lower priority now that
  the LAN service exists; useful for true offline travel.
- **LLM-from-scratch entries.** Words absent from the Kaikki dump (slang,
  in-universe coinages like *Quidditch*, *Muggle*) currently report `absent` and
  fall through to the on-demand chain. A gap-fill pass could generate and store
  KB entries for them (provenance `ai`, no offline source).

### 4a. More languages

The schema is multilingual by construction (`lang` on every entry); each new
language needs a Kaikki/Wiktextract dump plus tokenizer work where noted:

| Code | Language | Tokenizer readiness | Status |
| --- | --- | --- | --- |
| `es` | Spanish | `Intl.Segmenter` — ready today | Next |
| `pt-BR` | Portuguese | `Intl.Segmenter` — ready today | Planned |
| `ko` | Korean | boundaries OK; agglutination needs review | Planned |
| `cmn` | Mandarin | `Intl.Segmenter` does **not** do real Chinese segmentation — needs a dedicated (WASM) segmenter, loaded lazily | Planned |
| `tlh` | Klingon (pIqaD) | no open structured dataset; custom affix-aware tokenizer | Curation-only, experimental |

Also pending for non-English books: the English-only contraction/possessive
clitic rules in the tokenizer must be gated by the book's language so they never
fire on e.g. a Spanish book.

## 5. Home library server

Implemented: book store, per-profile vocabulary sync, shared AI-explanation
cache (see [home-server.md](home-server.md)). Still pending from the design:

- **Accounts.** Real users instead of the trusted "profile name": username +
  password (argon2id), signed session tokens, authorization on every protected
  route. Registration is self-service but an account starts `pending`.
- **Admin approval + age gating.** The admin (a parent) approves each pending
  account and confirms its `rating_tier` (defaulted from a declared birthdate).
  Books carry a rating (uploader sets, admin overrides); `GET /books` filters by
  `book.rating ≤ user.rating_tier` **server-side on every request**. This is the
  honest, LAN-proportionate version of "age verification".
- **Reading-progress sync.** A `reading_progress (user, book, word_index)` table
  and endpoints, so a book opened on the phone resumes where the laptop left
  off. Same last-write-wins model as vocabulary.
- **Shelf ACL (later).** Optional named shelves restricted to specific users
  (private shelf), independent of the age gate. Deliberately coarse.
- **OPDS export (later).** Publish the catalog as an OPDS feed so generic e-reader
  apps can browse/download the library too.
- **Operational polish.** Documented one-command backup (two SQLite files + the
  blob dir), total-storage display, delete-to-free-space, and rate limiting /
  lockout only if the threat model ever grows.

## 6. Word Swiper

- **Images on the card** (2–4 per word) to anchor meaning visually:
  - Keyless, CORS-friendly sources only: **Openverse** or **Wikimedia Commons**
    (keyed services deliberately avoided).
  - The disambiguating query is the key idea: send the word + its **book
    sentence** to the LLM and ask for a 2–3 keyword visual query ("Apple was
    founded…" → "apple computer logo"; "he ate an apple" → "apple fruit").
    Fallback without AI: word + key nouns from the dictionary definition.
  - Lazy-load thumbnails, cache per word, degrade gracefully for abstract words.
- Session settings: deck size cap, include/exclude the most common function
  words, remember skips for the session, show meaning before vs. after deciding.

## 7. Dictionary & Progress hubs

- **Recent activity** view (words moved to Known/Learning in the last 7/30 days)
  and per-week deltas.
- Optional **daily snapshot log** `[{date, known, learning}]` if last-change-only
  growth charts feel coarse; CSV export.
- A clean 4th bottom-nav slot is reserved for **Practice** once a global
  (cross-book) deck exists — today the swiper is launched per book from the shelf.
- When KB translations/locking land (§4), surface them in the same `dictRow`s
  (translations per sense, pin icon on locked fields).

## 8. Frequency-list seeding (explicitly opt-in, never default)

An optional "mark the N most frequent words as Known" bootstrap for users who
already have a base. The red-sea default (every unseen word starts Unknown) is a
product invariant — this feature must never become automatic.
