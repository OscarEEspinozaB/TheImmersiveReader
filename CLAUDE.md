# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language convention

Code, comments, identifiers, and internal documents are written in **English**. The
project's owner is learning English (that is the purpose of this app), so all
**conversation and chat responses to the user must be in Spanish**. Keep the
artifacts in English; speak to the user in Spanish.

## Documentation rules

- Every document in `docs/` (and this file, and the README) describes **only what
  is implemented**. Keep them in sync with the code when you change behavior.
- **All future plans live in exactly one place: [docs/vision.md](docs/vision.md).**
  Never add "pending / milestone / open questions" sections to other docs; when
  something in the vision gets built, document it in the matching feature doc and
  remove it from the vision.

## Product concept

"The Immersive Reader" is a vocabulary-learning reading tool. The user loads a book;
the app tokenizes it into words and colors each word by learning state:

- **Known** — white / light gray (blends into the background, zero friction)
- **Learning** — metallic orange / gold (subtly draws attention)
- **Unknown** — vibrant red (stands out as an alert)
- **Discarded** — recessive slate-blue (exempt: set *aside* as not learnable
  vocabulary of this language — proper nouns, code identifiers, Roman numerals,
  stray letters). Manual-only; kept out of totals/deck; counts as known for
  readability; reversible from the Dictionary hub.

**Default state is "Unknown" (the "red sea")** — every previously-unseen word starts
red on purpose, and state is **never changed automatically** (Discarded included: it
is only ever an explicit user action, never inferred from a missing dictionary entry). Vocabulary is keyed by
**normalized word scoped to the book's language** (`<lang>:<word>`), not by position:
marking one occurrence recolors every occurrence in that language across all books,
while the same spelling in another language stays independent. Each book carries its
own reading language; when it matches the user's native language the red sea is
suppressed. Contractions (`didn't`) are never vocabulary entries — they decompose
into component lemmas (`did` + `not`): color derives from the parts (most-urgent
wins), marking applies to all parts, stats expand them.

Clicking/holding a word sends the word **plus its full sentence** through the
definition layer for a context-aware, simple-language explanation. UI intent:
spartan, minimal cognitive load, dark mode primary.

## Architecture (implemented)

Two pieces:

- **Client** — vanilla JS + HTML + CSS (Vite, no framework). Ingests `.txt`/`.md`/
  `.pdf` (pdf.js) / `.epub` (fflate) client-side, tokenizes with `Intl.Segmenter`,
  renders the color-coded eReader, stores vocabulary/definitions in localStorage and
  books in IndexedDB. Fully functional offline on its own.
- **Home server** (optional, LAN) — one Node/Express process (`npm run server`,
  port 4321) with two SQLite files (better-sqlite3): the **dictionary KB** (seeded
  from a Kaikki/Wiktextract dump, AI-refined via a local Ollama), the **book
  library** (`.tir` upload/download), per-profile **vocabulary sync**
  (last-write-wins), and a shared cache of **context-aware AI explanations** (the
  client never calls Ollama directly for explanations). The server imports
  `src/normalize.js` / `src/words.js` so word keys never drift between client and
  server. No accounts yet — trusted LAN + profile names.

## Commands

- `npm run dev` — Vite dev server (`http://localhost:5173`, LAN-exposed).
- `npm run build` / `npm run preview` — production build / serve it.
- `npm run server` — the home server (`http://<ip>:4321`; data in `data/`, gitignored).
- `npm run ingest:en` — load `data/kaikki-en.jsonl` into the dictionary KB.
- `npm run ingest:forms` — rebuild only the KB's inflections table (~1 min).
- `npm run kb:audit [-- --fix --batch N --model M]` — find (and repair) refined
  entries that are wrong: stale contract, refined on an inflected form, "Plural of
  X." non-definitions, dirty POS. Re-run after every ingest.
- `npm run build:book -- "<file>" --batch N` — batch-refine a book's words
  (resumable; `--model M --force` re-refines with a stronger model).

No test runner. Verify with `npm run dev` (plus `npm run server` for
KB/sync/AI features) and the in-app "Load sample" button.

## Code map

- `src/ingest/` — per-format readers → `{ text, images }` (clean text + anchored
  illustrations; PDF de-hyphenation/paragraph reconstruction, EPUB spine order).
- `src/tokenizer.js` / `src/words.js` / `src/normalize.js` — segmentation and the
  word→key rule (normalize is shared with the server; keep it dependency-free).
- `src/vocabulary.js` — `<lang>:<word>` → `{ state, at }` store (localStorage; only
  non-default states persist) + change events for sync.
- `src/contractions.js` — contraction registry (surface → lemmas), color
  aggregation, Ollama-grown entries, data migrations.
- `src/reader/` — `render.js` (spans + bulk recolor), `paginator.js` (virtualized
  pages), `scroller.js` (continuous), `pageTurn.js` (drag turns), `theme.js`.
- `src/marking.js` + `src/gloss.js` + `src/popup.js` — the interaction rule:
  **gestures only open bubbles; actions are visible buttons inside** (never add
  a new hidden gesture). Tap on unknown/learning (or hold on any word) → the
  word bubble (definition, 🔊, state chips, ⋯ → full popup); double tap → the
  paragraph bubble (read aloud / copy); tap on a URL/e-mail token → the link
  bubble (open in new tab / copy). `src/speech.js` — Web Speech TTS.
- `src/definitions/` — provider chain: `localDict` → `kbApi` (home-server KB) →
  `dictionaryApi` (dictionaryapi.dev); `serverAi` (server-brokered explanations);
  `ollama.js` only decomposes contractions. `src/definitionsCache.js` caches per
  `<lang>:<word>`.
- `src/kbDetails.js` — the **family card**: a word is never shown loose when the KB
  knows its paradigm (bubble strip + full card in popup/Dictionary). It renders each
  form in the color of the state THAT form has, and never marks anything.
- `src/cover.js` — book covers: an uploaded one (scaled in-browser) vs the
  document's own opening image; anchored at offset 0 so the book opens with it.
- `src/library.js` / `src/shelf.js` / `src/tir.js` — IndexedDB library, shelf UI
  (incl. the readability badge: % of sentences whose every word is known —
  never word statistics; see docs/library.md), `.tir` book format.
  `src/serverLibrary.js` / `src/serverShelf.js` — the Server hub.
- `src/vocabSync.js` — offline-first vocabulary sync (outbox push, incremental pull).
- `src/dashboard.js` (+ `stats.js`, `charts.js`, `kbDetails.js`) — Dictionary &
  Progress hubs. `src/deck.js` / `src/swiper.js` — Word Swiper.
- `src/settings.js` — native language, default reading language, runtime **active**
  reading language (the open book's, read via `getReadingLang()`), home-server URL,
  profile, AI model override, reading mode/font, read-aloud voice + speed, shelf sort.
- `src/main.js` — view switching (`shelf | server | dictionary | progress | reader |
  swiper`) and wiring.
- `server/` — Express app: `routes/` (define, build, words, stats, books, vocab,
  aiDefine), `generate/` (refine + explain pipelines, book CLI), `ingest/` (Kaikki
  + `forms.js`), `db.js` / `library-db.js` (schemas), `lemma.js` (the lemma layer:
  formOf / family / verbForms grounding), `paradigms.js` (hand-curated paradigms).

Per-feature docs: [docs/design.md](docs/design.md) (core reader),
[docs/library.md](docs/library.md), [docs/home-server.md](docs/home-server.md),
[docs/dictionary-progress.md](docs/dictionary-progress.md),
[docs/word-swiper.md](docs/word-swiper.md) · Future: [docs/vision.md](docs/vision.md).

## Invariants (do not break)

- The red-sea default: unseen words are Unknown; no automatic state changes ever
  (frequency-list seeding, if ever built, is opt-in — see vision).
- Word keys: `<lang>:<normalized>` everywhere (vocabulary, caches, KB); client and
  server must share `normalize()` — never fork it.
- Contractions are never stored/counted as vocabulary words.
- Families (N tokens → 1 lemma) group for LOOKUP and COUNTING only — marking never
  propagates across a family, and inflections carry their part of speech (a plural
  noun is never labelled a verb form). They are the mirror of contractions (1 token
  → N lemmas), where marking DOES propagate; never merge the two mechanisms.
- Meaning is stored per LEMMA: an inflected form has no refined entry of its own, it
  is served its lemma's (the family card's banner states the link). Word STATE stays
  per surface form — that is the red sea, and it is untouched by this.
- The definition layer only *informs*; it never changes a word's state.
- The server stays thin: ingestion/tokenization happen on the client; books arrive
  as processed `.tir` archives.
