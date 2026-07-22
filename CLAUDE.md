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
  `npm run server:dev` — same, with auto-restart on `server/` changes (`node --watch`).
- `npm run ingest:en` — load `data/kaikki-en.jsonl` into the dictionary KB.
- `npm run ingest:forms` — rebuild only the KB's inflections table (~1 min).
- `npm run kb:audit [-- --fix --batch N --model M]` — find (and repair) refined
  entries that are wrong: stale contract, refined on an inflected form, "Plural of
  X." non-definitions, dirty POS. Re-run after every ingest.
- `npm run build:book -- "<file>" --batch N` — batch-refine a book's words
  (collapsed to lemmas; resumable; `--model M --force` re-refines with a stronger model).
- `npm run app:publish` — build the web and publish it to the home server as an OTA
  bundle; installed APKs pick it up on their next start (no reinstall).
- `npm run cap:sync` — build the web and copy it into the Android project
  (`vite build && cap sync android`). `npm run cap:open` — open it in Android Studio
  to run/build the APK. The APK is the same web app in a Capacitor WebView — one
  source of truth; web changes reach an installed APK over the air (`app:publish`),
  so `cap:sync` is only for native changes. See [docs/android.md](docs/android.md).

No test runner. Verify with `npm run dev` (plus `npm run server` for
KB/sync/AI features) and the "Load sample" button on the empty library.

### Shipping — the last step of every task

The phone runs the bundle the home server last published, not the working tree, so
a change that is not published does not exist for the user. **Finish every task that
touched the web (`src/`, `index.html`, `app.config.json`, styles) by running:**

```bash
npm run app:publish
```

Then say which version was published. Installed APKs download it at their next start
and apply it at the one after (or via the "Restart now" bar).

Rebuild the APK **only** when the change is native — a Capacitor plugin, `android/`,
`capacitor.config.json`, icons — because that cannot travel over the air:

```bash
npm run cap:sync && (cd android && ./gradlew assembleDebug)
# → android/app/build/outputs/apk/debug/app-debug.apk (must be installed by hand)
```

A native change still needs `app:publish` too: the APK's embedded bundle and the
published one should not drift apart.

## Code map

- `src/ingest/` — per-format readers → `{ text, images, blocks }` (clean flat
  text, anchored illustrations, and structure: headings/list-items/code/quotes
  as char RANGES over the text, never rewriting it — offsets are load-bearing;
  the contract lives in `ingest/index.js`. PDF de-hyphenation/paragraph+heading
  reconstruction from geometry, EPUB spine order, Markdown line syntax).
- `src/tokenizer.js` / `src/words.js` / `src/normalize.js` — segmentation and the
  word→key rule (normalize is shared with the server; keep it dependency-free).
- `src/vocabulary.js` — `<lang>:<word>` → `{ state, at }` store (localStorage; only
  non-default states persist) + change events for sync.
- `src/contractions.js` — contraction registry (surface → lemmas), color
  aggregation, Ollama-grown entries, data migrations.
- `src/reader/` — `render.js` (spans + bulk recolor + block containers: items
  inside a structure range render into `.reader__block--<type>` inline-block
  wrappers so the pre-wrap flow spaces them like plain paragraphs), `paginator.js` (virtualized
  pages), `scroller.js` (continuous), `pageTurn.js` (drag turns), `theme.js`,
  `position.js` (word index ↔ paragraph-anchored reading position — the unit that
  survives a device swap; a paragraph index + Nth word inside it).
- `src/marking.js` + `src/gloss.js` + `src/popup.js` — the interaction rule:
  **gestures only open bubbles; actions are visible buttons inside** (never add
  a new hidden gesture). Tap on unknown/learning (or hold on any word) → the
  word bubble (definition, 🔊, state chips, ⋯ → full popup); double tap → the
  paragraph bubble (continuous read-aloud from the tapped word — paragraph by
  paragraph to the book's end, highlighting each word as it is spoken, the page
  following the voice / copy / **translate this sentence**); tap on a URL/e-mail token
  → the link bubble (open in new tab / copy). **Translation is split on purpose:** the
  word bubble translates the word and its DICTIONARY EXPLANATION (never the book's
  sentence — the reader must understand the words, not be handed the book in Spanish);
  translating running text is a deliberate comprehension check, exists only in the
  paragraph bubble, and is scoped to **one sentence** while every other action there
  works on the paragraph — translation is kept **expensive on purpose** so it stays a
  check, never a crutch. Never widen that scope. In the full popup, an AI-produced answer carries
  a **↻ regenerate** button — one for the dictionary definition, one for the
  reading-language explanation, one for the native-language explanation — that
  re-runs the model and repaints in place.
  `src/speech.js` — TTS (Web Speech; native engine on Android) with per-word
  boundary callbacks; `src/readAloud.js` — the continuous paragraph-by-paragraph
  read-aloud session.
- `src/definitions/` — provider chain: `localDict` → `kbApi` (home-server KB) →
  `nativeWiktionary` (a MONOLINGUAL definition from the book language's own
  Wiktionary edition via its CORS-open MediaWiki API — so a Spanish book gets a
  Spanish definition, not an English gloss; parser validated for `es`, others fall
  through) → `freeDict` (freedictionaryapi.com — English Wiktionary, so its answer
  for a non-English word is an English translation; carries IPA); `serverAi`
  (server-brokered explanations). `mlkitTranslate` is separate from that chain: the
  away-from-home **translation** rescue (`translateToNative` = on-device ML Kit on
  Android → freedictionaryapi elsewhere), Android-only and never a dependency; it also
  exposes the installed-model list + an explicit download (Settings → Offline
  translation), because the implicit WiFi download fails silently;
  `ollama.js` only decomposes contractions. `src/definitionsCache.js` caches per
  `<lang>:<word>`.
- `src/kbDetails.js` — the **family card**: a word is never shown loose when the KB
  knows its paradigm (bubble strip + full card in popup/Dictionary). It renders each
  form in the color of the state THAT form has, and never marks anything.
- `src/cover.js` — book covers: an uploaded one (scaled in-browser) vs the
  document's own opening image; anchored at offset 0 so the book opens with it.
- `src/library.js` / `src/shelf.js` / `src/tir.js` — IndexedDB library, shelf UI
  (incl. the readability badge: % of sentences whose every word is known —
  never word statistics; see docs/library.md), `.tir` book format (v2 carries
  `blocks` in the manifest; v1 imports as the flat flow it always was).
  `src/serverLibrary.js` / `src/serverShelf.js` — the Server hub (incl. per-book
  dictionary coverage and the "build this book" job, driven from the app).
- `src/vocabSync.js` — offline-first vocabulary sync (outbox push, incremental pull).
  `src/positionSync.js` — cross-device reading-position sync, keyed by book **title**
  (not the device-local id): pull on open (jump if the server's is newer), push while
  reading. Last-write-wins by timestamp, same as vocab.
- `src/dashboard.js` (+ `stats.js`, `charts.js`, `kbDetails.js`) — Dictionary &
  Progress hubs. `src/deck.js` / `src/swiper.js` — Word Swiper.
- `src/settings.js` — native language, default reading language, runtime **active**
  reading language (the open book's, read via `getReadingLang()`), home-server URL,
  OTA update URL (Android-only; falls back to the home-server URL),
  profile, AI model override, reading mode/font, read-aloud voice + speed, shelf sort,
  detailed-log toggle.
  Build-time **defaults** are centralized in `app.config.json` (imported here) — the
  shipped home-server IP + default languages, so re-shipping them never touches code;
  every value stays user-overridable in Settings.
- `src/appUpdate.js` — Android OTA: pulls a newer web bundle from the home server
  and stages it for the next start. Never a dependency (no-op on web/offline).
- `src/diagnostics.js` — in-app log capture (a WebView has no devtools): a bounded
  ring of errors/warnings — always on; the **Detailed log** toggle adds the chatty
  levels — dumped into a **note** from Settings → Diagnostics. Imported FIRST in
  `main.js` so boot failures are caught. Use `logDiag`/`logDiagError` instead of
  letting a `catch` swallow why a feature gave up.
- `src/main.js` — view switching (`shelf | server | dictionary | progress | reader |
  swiper`) and wiring.
- `server/` — Express app: `routes/` (define, build, words, stats, books, vocab,
  position, aiDefine, appUpdate — the OTA bundle, published by `publishApp.js`),
  `generate/` (refine + explain pipelines, book CLI, `audit.js`;
  `gapfill.js` — seeds words the dump lacks from public dictionaries: `en` from
  freedictionaryapi, `es`/`fr`/`it`/`pt` from their OWN Wiktionary edition, so a
  non-English book gets same-language definitions and is `seeded`, never refined;
  `bookJob.js` — per-book coverage + the in-app build job), `ingest/` (Kaikki +
  `forms.js` + `epubText.js`), `db.js` / `library-db.js` (schemas), `lemma.js` (the
  lemma layer: formOf / family / verbForms grounding), `paradigms.js` (curated).

Per-feature docs: [docs/design.md](docs/design.md) (core reader),
[docs/library.md](docs/library.md), [docs/home-server.md](docs/home-server.md),
[docs/dictionary-progress.md](docs/dictionary-progress.md),
[docs/word-swiper.md](docs/word-swiper.md), [docs/android.md](docs/android.md)
(the Capacitor APK) · Future: [docs/vision.md](docs/vision.md).

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
