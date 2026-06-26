# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language convention

Code, comments, identifiers, and internal documents are written in **English**. The project's owner is learning English (that is the purpose of this app), so all **conversation and chat responses to the user must be in Spanish**. Keep the artifacts in English; speak to the user in Spanish.

## Project status

Phase 1 MVP is under construction. Milestone **M1** (the core loop) is implemented:
ingest `.txt`/`.md`/`.pdf` → tokenize → paginated eReader → red-sea coloring → click /
keyboard marking → persist to localStorage. See [docs/mvp-design.md](docs/mvp-design.md)
for the full design and remaining milestones (M2 definitions, M3 voice, M4 PWA).

## Commands

- `npm run dev` — start the Vite dev server (`http://localhost:5173`).
- `npm run build` — production build into `dist/`.
- `npm run preview` — serve the production build locally.

No test runner yet. Verify by running `npm run dev` and using the in-app "Load sample"
button (a public-domain text in `public/sample/`).

## Code map (Phase 1)

- `src/ingest/` — per-format readers (`txt`, `md`, `pdf` via pdf.js) + `index.js`
  dispatcher; always outputs one clean text string. `pdf.js` also normalizes
  hyphenation and hard line wraps.
- `src/tokenizer.js` — text → `Token[]` via `Intl.Segmenter`, preserving whitespace
  for exact re-render.
- `src/vocabulary.js` — `normalize()` + the word→state store, keyed by
  `<lang>:<normalized>` (the active book's language) so spellings don't collide
  across languages; default state is `unknown`, only non-default states persist to
  localStorage. `resetAll()` clears it.
- `src/settings.js` — persisted settings incl. the **default** reading language for
  new books, plus the runtime **active** reading language (the open book's), read by
  the tokenizer/sentences/definitions via `getReadingLang()`.
- `src/reader/` — `render.js` (word spans + bulk recolor), `paginator.js` (CSS
  multi-column paging), `theme.js` (dark/sepia).
- `src/marking.js` + `src/popup.js` — click/keyboard interaction to change a word's
  state and recolor all its occurrences.
- `src/main.js` — wires it all together.

## Product concept

"The Immersive Reader" is a vocabulary-learning reading tool. The user loads a plain-text book (e.g. a `.txt`); the app tokenizes it into words and colors each word by its learning state, tracked per-user in a database:

- **Known** — white / light gray (blends into background, zero friction)
- **Learning** — metallic orange / gold (subtly draws attention)
- **Unknown** — vibrant red (stands out as an alert)

**Default state is "Unknown" (the "red sea").** Every previously-unseen word starts red on purpose — the user wants to watch their knowledge grow as the red fades over time. Vocabulary state is keyed by **normalized word, scoped to the book's language** (`<lang>:<word>`, lowercased, punctuation stripped), not by position, so marking one occurrence recolors every occurrence across all texts **in that language** — while the same spelling in another language stays independent. Each book carries its own reading language (asked on add, editable later); when a book's language matches the user's native language the red sea is suppressed. An optional, opt-in "mark the N most frequent words as Known" feature may be added later, but it must never be the default behavior.

Clicking an unknown word sends the word **plus its full sentence** to a local LLM for a context-aware definition. The user can then promote the word to "Learning," which recolors it and persists the new state for future chapters.

Design intent for the UI: spartan, minimal cognitive load, flat 2D low-poly vector style, with dark mode as the primary target (deep black background) and a light/sepia mode as the alternate.

### Input formats

The app ingests `.txt`, `.md`, `.pdf`, and `.epub`. PDF text is extracted client-side (**pdf.js**) and is the messiest source — broken line wraps, hyphenation, and running headers/footers are normalized; paragraphs are reconstructed from geometry. EPUB (a ZIP of XHTML) is unzipped with **fflate**, read in spine order, with block elements → paragraphs. Both also extract embedded images, anchored by position. Markdown is flattened to plain reading text. Ingestion returns `{ text, images }`.

### eReader view

Text is presented as a comfortable reader (readable typography, dark / sepia themes), with the per-word color highlighting layered on top.

### Definition layer (pluggable providers)

Explanations for words being learned come from a **swappable provider interface** so the source can change without touching the UI. Provider chain, in order of preference: local dictionary → free dictionary API → AI model (Ollama at `localhost:11434`, or another API). The interface takes a word + its sentence and returns an explanation.

- **Explanations must be in simple / basic English** (the reading material is English; definitions stay English but simplified). For LLM providers this is a prompt instruction.
- **Future goal:** constrain explanations to vocabulary the user already knows. This does **not** require training or fine-tuning a model — it is done by passing the user's known-words list into the prompt (in-context) and instructing the model to explain using only those words.

### Core data lifecycle

Upload file (txt/md/pdf) → extract & normalize to clean text → tokenize → cross-reference each unique word against the store for its state → render the eReader with the color code → on interaction, fetch an explanation via the definition layer → show it → on user action, update the word's state in the store.

## Planned architecture

The design specifies a two-phase build. **Default to Phase 1 unless told otherwise.**

**Phase 1 — Local monolith (MVP):**

- Frontend: pure JavaScript, HTML5, CSS (no framework). Handles tokenization, coloring, and interaction.
- Storage: SQLite compiled to WebAssembly, running in the browser — full relational SQL with no backend server.
- LLM ("the brain"): frontend makes HTTP requests directly to a local **Ollama** instance at `http://localhost:11434`, passing the text segment to generate contextual definitions.

**Phase 2 — Client/server (future):**

- Frontend: a JS framework (React/Vue) or native mobile app; adds voice reading via Edge/Web Speech.
- Backend: **Rust** — orchestrates requests, cross-references the user DB, and brokers calls to Ollama.
- Database: centralized PostgreSQL (or SQLite).
- AI engine: an Ollama cluster (Llama 3 / Phi-3).

Phase 1 deliberately keeps everything client-side to enable fast iteration with zero server cost; the split into client/server only happens to support multi-device sync or multiple users.
