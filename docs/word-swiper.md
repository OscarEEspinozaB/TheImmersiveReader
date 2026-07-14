# The Immersive Reader — Word Swiper (implemented)

A Tinder-style swipe game, scoped to a book, whose job is **reinforcement**: a
word appears on a card with a sentence from the book, and a swipe assigns its
state. The design goal is *really knowing* the words being learned — that is
what buys reading fluency — not growing the known-word count fast; the deck and
labels are built around that. Launched per book from the shelf ("practice").
Built in `src/deck.js` (the deck) and `src/swiper.js` (the card UI). Card images
are future work ([vision.md](vision.md) §6).

## Gestures → state

- **Swipe up** 👍 → Known
- **Swipe down** 👎 → Unknown (explicitly leaves/sets the default)
- **Swipe left** 🤔 → Learning
- **Swipe right** → Skip (don't decide now)

Desktop: arrow keys and on-screen buttons mirror the gestures; a compass shows
the directions. The card animates out and the next appears.

## The deck (per book)

Built from the book's unique normalized words, **reinforcement first**:

1. **Learning words lead** (~60% of the deck), ordered by *least-recently
   touched* first — the words that most need a re-encounter (their `at`
   timestamp comes from the vocabulary store).
2. **New (unknown) words** follow (~30%), ranked by frequency in this book
   (most common first = most useful).
3. A few **known** words close the deck (~10%) as a light self-check.

Pools fill from each other when one runs short, so a fresh book (no learning
words yet) still deals a full deck of new words. Cards are tagged `reinforce` /
`new` / `review` accordingly. Contractions expand to their component lemmas and
numbers drop out (same lemma rules as everywhere else); **discarded (exempt)
words never enter the deck** — they are not study material. No new storage: marking
writes the global vocabulary store (with timestamps), so marked words naturally
move pools on the next build and show up in the Progress hub.

## Card UI

The word (large), its frequency in this book, and a sample sentence via the
existing sentence lookup. **Meaning is lazy** — revealed only on tap (cache →
dictionary/KB → AI, respecting availability) so the deck stays fast and doesn't
bias the self-check. A live per-book stats header, progress indicator, and an
end-of-session summary (how many marked Known / Learning / Unknown) close the
loop.

The revealed meaning also carries the word's **family card** (see
[design.md §6a](design.md)): the paradigm, each form in the color of its own state.
A form the deck also holds is a **button that jumps the deck to that card** — study
`was`, then step straight to `be` — because a paradigm is learned by walking it, not
by meeting its forms 30 cards apart. A form the deck does not hold stays a plain
chip. Jumping only moves the deck: a card is still only decided by swiping it.
