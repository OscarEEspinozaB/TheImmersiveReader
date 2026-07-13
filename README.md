# The Immersive Reader

A reading tool for learning a language by immersion. Load a book and every word
is color-coded by how well you know it. As you read and mark words, the page
shifts from a "red sea" of unknown words toward calm, known text — making your
vocabulary growth literally visible.

Two pieces: a **client** (vanilla JS, works fully offline on its own) and an
optional **home server** (Node + SQLite on your LAN) that gives every device the
same dictionary, book library, and synced progress. See [docs/](docs/) for the
per-feature documentation and [docs/vision.md](docs/vision.md) for future plans.

## Features

- **Library**: keep many books on a shelf (grid/list), with cover, editable
  title, per-book reading position and language, and sorting. Export/import any
  book as a portable **`.tir`** file. Each card shows a **readability badge** —
  "You can read N%": the share of the book's sentences where you know every
  word, so you pick material at your real level.
- **Ingest** `.txt`, `.md`, `.pdf`, and `.epub` client-side. PDF/EPUB text is
  reconstructed into clean paragraphs and embedded illustrations show inline.
- **Word states**: Unknown (red) → Learning (gold) → Known (blends in), plus a
  manual-only **Discarded** state (recessive slate-blue) that sets non-vocabulary
  tokens aside — proper nouns, code identifiers, Roman numerals — out of the
  totals and the study deck, counted as known for readability, and reversible
  from the Dictionary hub. The default is Unknown; state is **never** changed
  automatically. Keyed per
  language (`<lang>:<word>`), so marking one occurrence recolors every occurrence
  across books in that language, while the same spelling in another language
  stays independent. Books in your native language suppress the red sea.
- **Reading modes**: a virtualized **paged** eReader with live-drag page turns
  (tap the margins to turn, buttons/arrows animate the same slide) and a
  windowed **continuous** scroll mode. Selectable themes and reader typefaces
  (bundled Literata + system fonts).
- **Speech-bubble interaction**: tap an unknown or learning word and a bubble
  pops up next to it — definition, 🔊 (the word, then its meaning), state chips
  to mark it, and `⋯` for the full panel (AI contexts, explain-in-my-language).
  Hold works on any word (the better you know it, the longer the hold);
  double-tap opens the paragraph bubble: **read the paragraph aloud**, copy it,
  or copy the word. A floating `⏹ Stop reading` pill shows while audio plays.
  URLs and e-mail addresses stay whole as quietly-underlined link tokens (never
  vocabulary); tapping one opens the **link bubble** — open in a new tab or copy
  — instead of navigating away from the book.
- **Read-aloud** with the browser's built-in voices (offline, no server):
  words, meanings and paragraphs, with selectable **voice and speed** in the
  menu.
- **Definitions**: an offline **dictionary knowledge base** on the home server
  (seeded from a Wiktextract dump, AI-refined into simple English, with part of
  speech, verb tenses, synonyms/antonyms and lemma links) → free dictionary API
  fallback → context-aware **AI explanations** brokered and cached by the server
  (generated once, shared by every device), including an "explain in my
  language" rescue and web-dictionary links as a last resort.
- **Home library server**: upload processed books from one device, browse and
  download them on another; per-profile **vocabulary sync** (offline-first,
  last-write-wins) so progress follows you and survives a wiped browser.
- **Dictionary & Progress hubs**: bottom navigation with a searchable personal
  dictionary (per language, windowed for large vocabularies, with the growing
  server-built dictionary and a data stats card) and a Progress view (counts,
  donut, growth chart, per-book breakdown).
- **Word Swiper**: a per-book swipe game built for **reinforcement** — the deck
  leads with the words you're learning (least-recently touched first), then new
  words by frequency. Up = known, down = unknown, left = learning, right = skip.
- **Vocabulary export/import** to JSON, and a reset action (books are kept).

## Run

```bash
npm install
npm run dev        # client · http://localhost:5173 (also exposed on your LAN)
npm run build      # production build into dist/
npm run preview    # serve the production build
```

### Home server (optional, recommended)

```bash
npm run server     # Express + SQLite · http://<machine-ip>:4321
```

Point Settings → "Home server" at that URL (default `http://192.168.100.6:4321`).
Data lives in `data/` (gitignored): two SQLite files + a book blob dir — backup
is copying that folder.

- **Dictionary data**: download an English Kaikki.org (Wiktextract) dump to
  `data/kaikki-en.jsonl`, then `npm run ingest:en` (minutes, no LLM).
- **AI (optional)**: install [Ollama](https://ollama.com) on the server machine
  and pull a small model (default `gemma4:e2b`; override with
  `KB_EXPLAIN_MODEL`/`KB_REFINE_MODEL`). Clients never talk to Ollama directly —
  the server generates once and caches for everyone.
- **Pre-build a book's dictionary**:
  `npm run build:book -- "My Book.pdf" --batch 500` (resumable; re-run for the
  next batch; `--model X --force` re-refines with a stronger model).

If another device can't reach the app: same WiFi, router client-isolation off,
and open ports 5173/4321 in the host firewall. Find the machine's IP with
`hostname -I`.

## Tech

Vanilla JavaScript + HTML + CSS, built with [Vite](https://vitejs.dev). PDF via
[pdf.js](https://mozilla.github.io/pdf.js/), EPUB/zip via
[fflate](https://github.com/101arrowz/fflate). Server: Node +
[Express](https://expressjs.com) + [better-sqlite3](https://github.com/WiseLibs/better-sqlite3).
No framework.

## License

MIT
