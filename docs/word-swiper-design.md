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

## 5. Entry point

- A **"Practice"** action on a book in the library (and/or in the reader menu),
  since the deck is per book.

## 6. Modules

- `deck.js` — build the ranked deck (unique unknown words + frequency + sample
  sentence) from a book's tokens.
- `swiper.js` — the card UI, gesture/keyboard handling, animations, session summary.
- Reuses: `vocabulary.setState` (timestamps), `sentences.js`, the definition layer,
  `main.js` view switching (a fourth view, or a modal over the reader).

## 7. Milestones

1. Deck builder (unique unknown words by frequency + sample sentence).
2. Swiper UI with gestures/keys/buttons → set state, next card.
3. Lazy meaning reveal + end-of-session summary.
4. Polish: animations, "skip remembered for session", settings (include/exclude
   common words, deck size, order).

## 8. Open questions

- Left swipe = Skip or Learning? (Leaning Skip, with Learning on right.)
- Deck size cap per session (e.g. 50 cards) to keep it a short, repeatable game?
- Show meaning before or only after deciding (to avoid biasing the "do I know it?"
  self-check)?
