# The Immersive Reader — MVP Design

> Status: Draft · Phase 1 (local monolith) · Last updated 2026-06-21

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
- State is keyed by the **normalized word**, so marking one occurrence updates all
  occurrences across every text.
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
| State key | Normalized word (lowercased, punctuation stripped) | One global vocabulary; marking a word recolors every occurrence everywhere. Decouples progress from any single document. |
| Stack | Vanilla JS + HTML + CSS, built with **Vite** | Matches the project vision, zero framework weight, good for learning. |
| Tokenizer | `Intl.Segmenter` (native) | Correct word segmentation including apostrophes ("don't", "Harry's"), no library. |
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

// Persisted vocabulary: only non-default states are stored.
// Any word absent from the map is treated as "unknown" (the red-sea default).
Vocabulary: Map<normalizedWord, WordState>

Token = {
  text: string          // original surface form, e.g. "Harry's"
  normalized: string    // e.g. "harry's" — the vocabulary key
  isWord: boolean       // false for whitespace/punctuation chunks
}
```

Normalization: lowercase + trim surrounding punctuation, preserving internal
apostrophes/hyphens. Whitespace and punctuation tokens are rendered verbatim and
are not clickable.

## 7. Modules (proposed)

- `ingest/` — readers per format (`txt`, `md`, `pdf` via pdf.js) → clean text. PDF
  reader also handles de-hyphenation and line-wrap repair.
- `tokenizer.js` — text → `Token[]` using `Intl.Segmenter`.
- `vocabulary.js` — the `Map`, normalization, get/set state, persistence.
- `reader/` — eReader rendering, theming, re-coloring on state change.
- `marking.js` — click + keyboard interaction to change state.
- `definitions/` — `DefinitionProvider` interface + implementations (stub for MVP).
- `speech.js` — Web Speech API wrapper.

## 8. Milestones

1. **M1 — Core loop (txt/md/pdf):** ingest all three formats — including PDF via
   pdf.js with text normalization (de-hyphenation, line-wrap repair) — → tokenize →
   paginated eReader render → red sea → click-popup / shortcut marking → recolor all
   occurrences → persist to localStorage. **PDF ingest is part of M1.**
2. **M2 — Definitions** ✅: `DefinitionProvider` chain (local dict → free dictionary
   API → Ollama). Explanations in **simple/basic English**. Sentence context via
   `Intl.Segmenter` sentence granularity; result shown in the word popup.
3. **M3 — Voice:** Web Speech read-aloud (word, sentence, and full text).
4. **M4 — PWA:** manifest + service worker for installability and offline use.

Also done outside the original milestone list: **session persistence** — the last
opened document and reading position (anchored by word index) are saved to
localStorage and restored on startup.

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
