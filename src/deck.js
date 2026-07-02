// Word Swiper deck builder. The game exists to REINFORCE the words the user is
// learning — really knowing a word is what buys reading fluency, not growing the
// known-words number fast. So the deck leads with the LEARNING words, oldest
// last-touch first (the ones most in need of a re-encounter), then brings in new
// (unknown) words by frequency, and closes with a few known ones as a light check.
// Pools fill from each other when one runs short, so a fresh book (no learning
// words yet) still deals a full deck of new words.

import { tokenize } from './tokenizer.js';
import { buildSentenceLookup } from './sentences.js';
import { getStateInfo } from './vocabulary.js';
import { getReadingLang } from './settings.js';
import { parts as contractionParts } from './contractions.js';

// Target share of the deck per state (filled from other pools when one is short).
// Learning leads on purpose — reinforcement over acquisition.
const MIX = { learning: 0.6, unknown: 0.3, known: 0.1 };

// The vocabulary lemmas a token contributes. A contraction expands into its
// component words (so "didn't" counts as "did" + "not", never as a word of its
// own); an ordinary word is its single normalized key; numbers are ignored.
function lemmasOf(token) {
  if (!token.isWord) return [];
  const p = contractionParts(token.text);
  if (p) return p.filter((l) => l && !/^\d+$/.test(l));
  return token.normalized && !/^\d+$/.test(token.normalized) ? [token.normalized] : [];
}

/**
 * Everything the shelf/hubs need to know about a book's text, in ONE
 * tokenization pass: its unique lemmas (in first-appearance order), their
 * occurrence counts, and — per sentence — which lemmas each sentence uses
 * (as indexes into `words`). The sentence structure is what backs the shelf's
 * "how much of this book can you actually READ" badge: a sentence is readable
 * only when every word in it is known, so the badge speaks in units of
 * reading, not word statistics.
 * @param {string} text the book's clean text
 * @returns {{ words: string[], counts: number[], sentences: number[][] }}
 */
export function bookWordData(text) {
  const lang = getReadingLang();
  const tokens = tokenize(text);

  // Sentence end-offsets in document order (Intl.Segmenter, like sentences.js).
  const bounds = [];
  for (const s of new Intl.Segmenter(lang, { granularity: 'sentence' }).segment(text)) {
    bounds.push(s.index + s.segment.length);
  }

  const indexOf = new Map(); // lemma -> index into words[]
  const words = [];
  const counts = [];
  const sentences = [];
  let si = 0;
  let offset = 0;
  let cur = new Set();
  const flush = () => {
    if (cur.size) sentences.push([...cur]);
    cur = new Set();
  };

  for (const t of tokens) {
    while (si < bounds.length && offset >= bounds[si]) {
      flush(); // the previous sentence ended before this token
      si += 1;
    }
    if (t.isWord) {
      for (const lemma of lemmasOf(t)) {
        let i = indexOf.get(lemma);
        if (i === undefined) {
          i = words.length;
          indexOf.set(lemma, i);
          words.push(lemma);
          counts.push(0);
        }
        counts[i] += 1;
        cur.add(i);
      }
    }
    offset += t.text.length;
  }
  flush();

  return { words, counts, sentences };
}


/**
 * @param {string} text the book's clean text
 * @param {{ limit?: number }} [opts]
 * @returns {{ cards: { word, count, sentence, state }[],
 *             stats: { total, known, learning, unknown } }}
 */
export function buildDeck(text, { limit = 50 } = {}) {
  const tokens = tokenize(text);
  const getSentence = buildSentenceLookup(text, tokens);

  const info = new Map(); // lemma -> { count, firstWordIndex, state, at }
  let wordIndex = -1;
  for (const t of tokens) {
    if (!t.isWord) continue;
    wordIndex += 1; // one index per word token (contractions included) for sentences
    for (const w of lemmasOf(t)) {
      let e = info.get(w);
      if (!e) {
        const { state, at } = getStateInfo(w);
        e = { count: 0, firstWordIndex: wordIndex, state, at };
        info.set(w, e);
      }
      e.count += 1;
    }
  }

  const stats = { total: info.size, known: 0, learning: 0, unknown: 0 };
  const pools = { unknown: [], learning: [], known: [] };
  for (const [word, e] of info) {
    stats[e.state] += 1;
    pools[e.state].push({ word, count: e.count, sentence: getSentence(e.firstWordIndex), state: e.state, at: e.at });
  }
  // Learning words: least-recently touched first — the longer since the last
  // encounter, the more the word needs reinforcing. New words: most frequent
  // first (most useful to learn). Known: shuffled light check.
  pools.learning.sort((a, b) => (a.at || 0) - (b.at || 0));
  pools.unknown.sort((a, b) => b.count - a.count);
  shuffle(pools.known);

  // Reinforcement leads: learning first, then new words, then a few known. NO
  // final frequency sort (that would pull known function words back to the top).
  const deck = [];
  for (const k of ['learning', 'unknown', 'known']) {
    deck.push(...pools[k].splice(0, Math.round(limit * MIX[k])));
  }
  if (deck.length < limit) {
    deck.push(...pools.learning, ...pools.unknown, ...pools.known);
  }

  return { cards: deck.slice(0, limit), stats };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
