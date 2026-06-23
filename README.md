# The Immersive Reader

A reading tool for learning English by immersion. Load a book (`.txt`, `.md`, or
`.pdf`) and every word is color-coded by how well you know it. As you read and mark
words, the page shifts from a "red sea" of unknown words toward calm, known text —
making your vocabulary growth literally visible.

> Phase 1 MVP — a fully client-side app (no backend). See
> [docs/mvp-design.md](docs/mvp-design.md) for the design.

## Features

- **Ingest** `.txt`, `.md`, `.pdf`, and `.epub` (PDF/EPUB text is reconstructed into
  clean paragraphs; embedded illustrations are shown).
- **Word states**: Unknown (red) → Learning (gold) → Known (blends in). The default
  is Unknown — you grow your vocabulary by marking words; state is never changed
  automatically.
- State is keyed by the **normalized word**, so marking one occurrence recolors
  every occurrence across the whole book; it persists across sessions.
- **Paginated eReader** that's virtualized (only the current page is in the DOM), so
  huge books don't freeze the browser. Swipe / arrows / buttons to turn pages.
- **Definitions** on tap: a dictionary plus, if available, a local **Ollama** model
  giving a context-aware explanation in simple English, with a per-context history.
  An on-demand "explain in my language" rescue and links to web dictionaries
  (Cambridge, Oxford, …) when nothing else has an answer.
- Selectable **color themes** (dark + light) and an auto-hiding, minimal UI.
- Reading position, vocabulary, and the current document (with images) are saved
  locally (localStorage + IndexedDB).

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
images are extracted client-side with [pdf.js](https://mozilla.github.io/pdf.js/).
No framework, no backend.

## License

MIT
