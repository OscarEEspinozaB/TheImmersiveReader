// Word Swiper deck builder. From a book's text, compute the per-book vocabulary
// breakdown and a practice deck that MIXES states for reinforcement: mostly new
// (unknown) words, some learning, a few known — ranked by frequency. As new words
// run out (a book's vocabulary is finite), the mix naturally shifts toward review.

import { tokenize } from './tokenizer.js';
import { buildSentenceLookup } from './sentences.js';
import { getState } from './vocabulary.js';

// Target share of the deck per state (filled from other pools when one is short).
const MIX = { unknown: 0.7, learning: 0.2, known: 0.1 };

/** Unique normalized words in a text (for per-book stats). @returns {string[]} */
export function uniqueWords(text) {
  const set = new Set();
  for (const t of tokenize(text)) {
    if (t.isWord && t.normalized && !/^\d+$/.test(t.normalized)) set.add(t.normalized);
  }
  return [...set];
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

  const info = new Map(); // word -> { count, firstWordIndex, state }
  let wordIndex = -1;
  for (const t of tokens) {
    if (!t.isWord) continue;
    wordIndex += 1;
    const w = t.normalized;
    if (!w || /^\d+$/.test(w)) continue;
    let e = info.get(w);
    if (!e) {
      e = { count: 0, firstWordIndex: wordIndex, state: getState(w) };
      info.set(w, e);
    }
    e.count += 1;
  }

  const stats = { total: info.size, known: 0, learning: 0, unknown: 0 };
  const pools = { unknown: [], learning: [], known: [] };
  for (const [word, e] of info) {
    stats[e.state] += 1;
    pools[e.state].push({ word, count: e.count, sentence: getSentence(e.firstWordIndex), state: e.state });
  }
  // New words: most frequent first (most useful to learn). Reviews: shuffled, so
  // it isn't always the same high-frequency function words ("the", "and"…).
  pools.unknown.sort((a, b) => b.count - a.count);
  shuffle(pools.learning);
  shuffle(pools.known);

  // New words lead; then learning review, then known review. NO final frequency
  // sort (that would pull known function words back to the top).
  const deck = [];
  for (const k of ['unknown', 'learning', 'known']) {
    deck.push(...pools[k].splice(0, Math.round(limit * MIX[k])));
  }
  if (deck.length < limit) {
    deck.push(...pools.unknown, ...pools.learning, ...pools.known);
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
