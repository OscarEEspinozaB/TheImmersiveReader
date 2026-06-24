# The Immersive Reader

A reading tool for learning English by immersion. Load a book and every word is
color-coded by how well you know it. As you read and mark words, the page shifts from
a "red sea" of unknown words toward calm, known text — making your vocabulary growth
literally visible.

> Phase 1 MVP — a fully client-side app (no backend). See [docs/](docs/) for the
> design documents.

## Features

- **Library**: keep many books on a shelf (grid/list), with cover, editable title,
  per-book reading position, and sorting (last read / title / added).
- **Ingest** `.txt`, `.md`, `.pdf`, and `.epub`. PDF/EPUB text is reconstructed into
  clean paragraphs (PDF from page geometry; EPUB in spine order) and embedded
  illustrations are shown inline.
- **Word states**: Unknown (red) → Learning (gold) → Known (blends in). The default
  is Unknown — you grow your vocabulary by marking words; state is **never** changed
  automatically. Keyed by the **normalized word**, so marking one occurrence recolors
  every occurrence across all books, and it persists.
- **Reading modes**: a virtualized **paginated** eReader (only the current page is in
  the DOM, so huge books don't freeze) with swipe / arrows / buttons, and a windowed
  **continuous** scroll mode (so external read-aloud can see the text).
- **Definitions** on tap: dictionary (local cache → free API) plus, if available, a
  local **Ollama** model for context-aware explanations in simple English — including
  part of speech and verb forms/tenses — kept as a per-context history. An on-demand
  "explain in my language" rescue, and web-dictionary links (Cambridge, Oxford, …)
  when nothing else has an answer.
- **Vocabulary dashboard**: a Stats tab (known/learning counts, a growth chart, and a
  per-book breakdown) and a Dictionary tab (search/filter/sort your words with their
  dictionary + AI meanings; the list is windowed for large vocabularies).
- **Word Swiper**: a Tinder-style game per book to triage/reinforce words fast —
  swipe up = known, down = unknown, left = learning, right = skip.
- Selectable **color themes** (dark + light), themed scrollbars, an auto-hiding
  minimal UI, in-app dialogs, and **vocabulary export/import** to a JSON file.
- Configurable **Ollama URL + model** and **reading / native language**.
- Saved locally: vocabulary and definitions cache in localStorage; books (text +
  images) and reading positions in IndexedDB.

## Run

```bash
npm install
npm run dev      # http://localhost:5173 (also exposed on your local network)
npm run build    # production build into dist/
npm run preview  # serve the production build
```

### Optional: AI definitions with Ollama

Install [Ollama](https://ollama.com), pull a small model (e.g. `ollama pull
gemma3:4b`), and it will be used automatically. To reach it from other devices on
your network (e.g. a phone), run it exposed:

```bash
OLLAMA_HOST=0.0.0.0 OLLAMA_ORIGINS=* ollama serve
```

## Tech

Vanilla JavaScript + HTML + CSS, built with [Vite](https://vitejs.dev). PDF text and
images are extracted client-side with [pdf.js](https://mozilla.github.io/pdf.js/);
EPUB is unzipped with [fflate](https://github.com/101arrowz/fflate). No framework, no
backend.

## License

MIT
