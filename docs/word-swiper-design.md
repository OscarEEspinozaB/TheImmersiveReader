# The Immersive Reader — Word Swiper (Tinder-style) (Design)

> Status: Draft (design only, not implemented). Last updated 2026-06-23.

## 1. Context

Marking words while reading is great but slow to seed a large vocabulary. A
**Tinder-style swipe game**, scoped to a book, lets the user triage many words fast
and playfully: a word appears on a card (with a sentence from the book for context),
and a swipe assigns its state. This quickly fills the user's knowledge list.

It reuses everything we have: the book's tokens, the vocabulary store (now with
timestamps, see the dashboard design), and the cached definitions.

## 2. Gestures → state

- **Swipe up** 👍 → **Known**
- **Swipe down** 👎 → **Unknown** (explicitly leaves/sets it unknown)
- **Swipe right** 🤔 → **Learning**
- **Swipe left** → **Skip** (don't decide now) — *could* also map to Learning; TBD.

On desktop: arrow keys (↑ known, ↓ unknown, → learning, ← skip) and on-screen buttons.
The card animates in the swipe direction and the next card appears. State changes use
the global store (so they show up everywhere, with their timestamp for stats).

## 3. The deck (per book)

Build a deck from the open book's tokens:

- Unique **normalized words** that are currently **Unknown** (skip words already
  Known/Learning — you're filling in new ones).
- Ranked by **frequency desc** (most common first = most useful to learn), with the
  count shown. (Alternative order: first appearance.)
- Each card carries a **sample sentence** from the book (via the existing sentence
  lookup) so the word has context.
- Optionally filter out the N most frequent English function words, or include them —
  reuse/relate to the opt-in "mark common words as known" idea.

No new storage: marking changes state in the global vocabulary; next time the deck is
built, marked words are naturally excluded. (Optional: remember "skipped" words per
session so they don't reappear immediately.)

## 4. Card UI

```text
┌─────────────────────────┐
│            👍 known        │
│                          │
│        w a n d           │   ← the word (large)
│      seen 23×            │   ← frequency in this book
│                          │
│  "...he waved his wand   │   ← a sentence from the book
│   and..."                │
│      (tap to reveal)     │   ← optional meaning on tap (cache/dict/AI)
│  👎 unknown   🤔 learning  │
└─────────────────────────┘
        ← skip
```

- **Meaning is lazy**: show word + context; reveal the definition only on tap (from
  cache → dictionary → AI, respecting availability) so the deck stays fast.
- Buttons mirror the gestures for non-touch devices.
- A progress indicator (card i / N) and an **end-of-session summary** (how many marked
  Known / Learning / Unknown, words/min).

## 4b. Images (visual association)

Show **2–4 related images** per card to anchor meaning visually.

- **API**: prefer a **keyless, CORS-friendly** source (to match the no-API-key
  direction): **Openverse** (`api.openverse.org`, CC images) or **Wikimedia
  Commons**. Keyed services (Unsplash/Pexels/Pixabay) are deliberately avoided.
- **Disambiguating query** (the key idea): image search matches keywords, not full
  sentences, AND a generic dictionary sense can't tell the brand from the fruit — only
  a model that reads the CONTEXT can. Since the deck comes from a book, each card has
  the book sentence, so:
  - **Primary (AI, context-aware):** send `word` + the **book sentence** to Ollama and
    ask for a short visual image-search query (2–3 keywords). This resolves
    brand-vs-fruit etc. (e.g. "Apple was founded by…" → "apple computer logo"; "he ate
    an apple" → "apple fruit").
  - **Fallback (no AI):** build `word` + 1–2 key nouns from the dictionary definition.
    Best-effort, uses the common sense, no context guarantee.
- **Behavior**: lazy-load thumbnails; cache results per word (avoid refetching);
  graceful when there are no good images (abstract/function words) — just show text.
- **Licensing**: CC sources include attribution/license info; fine for personal use.

## 6. Modules

- `deck.js` — build the ranked deck (unique unknown words + frequency + sample
  sentence) from a book's tokens.
- `swiper.js` — the card UI, gesture/keyboard handling, animations, session summary.
- `images.js` — build the disambiguating query and fetch/cache 2–4 images
  (Openverse/Wikimedia, keyless).
- Reuses: `vocabulary.setState` (timestamps), `sentences.js`, the definition layer,
  `main.js` view switching (a fourth view, or a modal over the reader).

## 7. Milestones

1. Deck builder (unique unknown words by frequency + sample sentence).
2. Swiper UI with gestures/keys/buttons → set state, next card.
3. Lazy meaning reveal + end-of-session summary.
4. Images on the card (keyless API + disambiguating query, cached).
5. Polish: animations, "skip remembered for session", settings (include/exclude
   common words, deck size, order, images on/off).

## 8. Open questions

- Left swipe = Skip or Learning? (Leaning Skip, with Learning on right.)
- Deck size cap per session (e.g. 50 cards) to keep it a short, repeatable game?
- Show meaning/images before or only after deciding (to avoid biasing the self-check)?
- Image source: Openverse vs Wikimedia Commons (both keyless) — pick during build.
