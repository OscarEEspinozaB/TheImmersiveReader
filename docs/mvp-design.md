# The Immersive Reader — MVP Design

> Status: Phase 1 largely built · Last updated 2026-06-24
>
> Done: M1 core loop (txt/md/pdf + epub), M2 definitions (dictionary + Ollama, with
> part-of-speech & verb forms), plus features beyond the original plan — multi-book
> **library**, **continuous** reading mode, **vocabulary dashboard** (stats +
> dictionary), **word swiper**, themes, configurable Ollama/language, vocabulary
> export/import. Pending: **M3 voice** (Web Speech — continuous mode currently enables
> external read-aloud instead), **M4 PWA**, swiper images, and the `.tir` book format.
> See the per-feature docs in this folder.

## 1. Purpose & vision

The Immersive Reader is a reading tool for learning English by immersion. The user
loads a real text (e.g. a Harry Potter chapter), reads it in a comfortable eReader
view, and every word is color-coded by how well the user knows it. Over time the
user marks words and the page shifts from a "red sea" of unknown words toward calm,
known text — making vocabulary growth literally visible.

## 2. Goals (MVP)

- Ingest a document (`.txt`, `.md`, and **`.pdf`** — all first-class from the start)
  and extract its full text. PDF is a core requirement, not a later add-on.
- Render it as a distraction-free eReader (dark / sepia themes).
- Color every word by learning state: **Known**, **Learning**, **Unknown**.
- Let the user change a word's state with one click (and keyboard shortcuts).
- State is keyed by the **normalized word per language** (`<lang>:<word>`), so marking
  one occurrence updates every occurrence across texts **in that language** (without
  colliding with the same spelling in another language).
- Persist vocabulary locally so progress survives reloads and carries across texts.
- Read text aloud with the browser's built-in voices (Web Speech API).

## 3. Non-goals (MVP)

- Accounts, cloud sync, or multi-device support (Phase 2).
- A real database engine (SQLite-WASM). MVP uses `localStorage`.
- Rich rendering of Markdown formatting (Markdown is flattened to reading text).
- AI explanations are **stubbed behind an interface** in the MVP; the working
  provider chain lands in the next milestone (see §8).
- Training or fine-tuning any model.

## 4. Key decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Default word state | **Unknown ("red sea")** | The user wants to watch the red fade as knowledge grows. A frequency-list "mark common words as Known" feature is **opt-in, future** — never the default. |
| State key | `<lang>:<normalized word>` (lowercased, punctuation stripped, possessive `'s` removed) | One vocabulary **per language**; marking a word recolors every occurrence in that language. `Dursley's` → `en:dursley`. Decouples progress from any single document while keeping `no`/`son`/`casa` distinct across languages. |
| Reading language | **Per book** (asked on add, editable later); a persisted *default* seeds new books | The tokenizer, sentence splitter and dictionary follow the open book. When the book's language equals the user's native language the red sea is suppressed (they already know it). |
| Stack | Vanilla JS + HTML + CSS, built with **Vite** | Matches the project vision, zero framework weight, good for learning. |
| Tokenizer | `Intl.Segmenter` (native) | Correct word segmentation including apostrophes ("don't", "Harry's"), no library. Curly apostrophes are normalized to straight. |
| Contractions | Decomposed into component lemmas; never a vocabulary entry of their own | `didn't` = `did` + `not`. Color is derived from the parts (most-urgent wins), marking applies to all parts, stats expand them — so a contraction never counts as a new word. Registry is seeded + grown by Ollama. See `contractions.js`. |
| Storage | `localStorage` (MVP) → IndexedDB/Dexie → SQLite-WASM later | Vocabulary is small (word → state). Start simple; the state-by-word model makes migration trivial. |
| Voice | Web Speech API `SpeechSynthesis` | Uses system/Edge voices, free and native. |
| Definitions | Pluggable `DefinitionProvider` interface | Swap source (local dict → free API → Ollama) without touching the UI. |
| Packaging | PWA first → Tauri 2 (native desktop/mobile) → Rust backend | Reuses the same web codebase at every step; Tauri's Rust matches the Phase 2 plan. |

## 5. Architecture (Phase 1, all client-side)

```text
File (txt/md/pdf)
   │  ingest + normalize
   ▼
Clean text string
   │  Intl.Segmenter
   ▼
Tokens (word + surrounding punctuation/whitespace, preserved for exact re-render)
   │  cross-reference
   ▼
Vocabulary store  (word → state, persisted in localStorage)
   │  render
   ▼
eReader view  (each word = element tagged with its normalized word + state class)
   │  user clicks / shortcut
   ▼
State change → recolor ALL matching words → persist
   │  (Learning/Unknown word) request explanation
   ▼
DefinitionProvider → explanation shown in popup
```

## 6. Data model

```text
WordState = "known" | "learning" | "unknown"

// Persisted vocabulary: only non-default states are stored. Keys are scoped by
// the book's language ("<lang>:<normalizedWord>", e.g. "en:harry").
// Any word absent from the map is treated as "unknown" (the red-sea default).
Vocabulary: Map<"<lang>:<normalizedWord>", WordState>

Token = {
  text: string          // original surface form, e.g. "Harry's"
  normalized: string    // e.g. "harry" — the vocabulary key (possessive 's stripped)
  isWord: boolean       // false for whitespace/punctuation chunks
}
```

Normalization: lowercase + curly→straight apostrophes + trim surrounding
punctuation, preserving internal apostrophes/hyphens, then strip a trailing
possessive `'s`. Whitespace and punctuation tokens are rendered verbatim and are
not clickable.

**Contractions** are a special case (see `contractions.js`). A contraction
(`didn't`, `you'd`, `it's`, `let's`) is *not* a vocabulary word — it is a
shorthand for two real words — so it is never stored or counted on its own.
Instead it maps to its component lemmas (`didn't` → `[did, not]`):

- its reader color is **derived** from the components — the most-urgent state
  wins (red if any part is unknown, orange if any is learning, white only when
  all are known), so the red sea fades as the underlying words are learned;
- marking it applies the chosen state to **all** components at once;
- in stats/decks it expands into its components, never counting as a unique word.

The registry ships with the common English contractions and **grows at runtime**:
an unseen contraction is decomposed in context by Ollama (resolving `'d` →
would/had, `'s` → is/has), then cached and persisted. Genuine possessives
(`Dursley's`) are handled separately by `normalize()` and are *not* in the
registry. Two migrations keep old data consistent: vocabulary entries saved as
whole contractions are re-mapped to their lemmas on load, and per-book word lists
are versioned so stale lists are recomputed.

## 7. Modules (proposed)

- `ingest/` — readers per format (`txt`, `md`, `pdf` via pdf.js) → clean text. PDF
  reader also handles de-hyphenation and line-wrap repair.
- `tokenizer.js` — text → `Token[]` using `Intl.Segmenter`.
- `vocabulary.js` — the `Map`, normalization, get/set state, persistence.
- `contractions.js` — contraction registry (surface → component lemmas), color
  aggregation, AI-grown entries, and the old-data migration.
- `reader/` — eReader rendering, theming, re-coloring on state change.
- `marking.js` — click + keyboard interaction to change state.
- `definitions/` — `DefinitionProvider` interface + implementations (stub for MVP).
- `speech.js` — Web Speech API wrapper.

## 8. Milestones

1. **M1 — Core loop** ✅: ingest (txt/md/pdf, later +epub) → tokenize → eReader render
   → red sea → click-popup / shortcut marking → recolor all occurrences → persist.
2. **M2 — Definitions** ✅: provider chain (local cache → free dictionary API → Ollama).
   Context-aware, simple-English explanations with part of speech and verb forms;
   per-context AI history; web-dictionary fallback links.
3. **M3 — Voice** ⏳ pending: Web Speech read-aloud. (For now, the **continuous**
   reading mode puts the whole text in the DOM so the browser's own read-aloud works.)
4. **M4 — PWA** ⏳ pending: manifest + service worker for install/offline.

Delivered beyond the original list (each has its own doc in `docs/`): session
persistence, multi-book **library**, **per-book reading language** (with red-sea
suppression when it matches the native language), **continuous** reading mode,
**vocabulary dashboard** (stats + dictionary), **word swiper**, selectable themes,
configurable Ollama URL/model and native/default reading language, vocabulary
export/import, and a vocabulary **reset**.

## 9. Definition layer detail

Interface: `getDefinition(word, sentence) → { explanation, source }`.

- LLM providers are prompted to answer in **simple, basic English**.
- **Caching** (`src/definitionsCache.js`): each word's dictionary / AI / native-
  language results are stored (keyed by normalized word) so a repeat lookup is
  instant and never re-queries. localStorage for now → IndexedDB when it grows.
- **State-dependent behavior** (the popup never changes a word's state):
  - **Unknown / Learning** → show definitions automatically, cache-first.
  - **Known** → no auto-fetch; a "Look it up" button shows it on demand (cached).
- On-demand **"Explain in &lt;language&gt;"** rescue (native language via Ollama),
  also cached.
- **Future:** pass the user's known-words list into the prompt and instruct the
  model to explain using only those words (in-context, no training required). This
  is what makes explanations progressively easier as the user's vocabulary grows.

## 10. Resolved & open questions

Resolved:

- eReader layout → **paginated** (page turns), not continuous scroll.
- Marking UX → **click opens a 3-button popup** (Known / Learning / Unknown), plus
  `1`/`2`/`3` keyboard shortcuts.

More resolved:

- Sentence detection → **`Intl.Segmenter` sentence granularity** (`src/sentences.js`).
- Free dictionary API → **dictionaryapi.dev** (no API key) as the non-AI fallback.

Open:

- Provider order: dictionary API currently precedes Ollama (per the design's
  preference order). May flip to prioritize Ollama's context-aware, simple-English
  explanations once Ollama networking is set up.
- Ollama from a phone needs `OLLAMA_HOST=0.0.0.0` + `OLLAMA_ORIGINS` (CORS).
- Large files: storage (localStorage → IndexedDB) and render virtualization.
