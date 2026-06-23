// Word Swiper deck builder: from a book's text, produce a ranked deck of the
// words the user hasn't engaged with yet (currently Unknown), each with its
// frequency and a sample sentence for context. Most frequent first (most useful
// to learn).

import { tokenize } from './tokenizer.js';
import { buildSentenceLookup } from './sentences.js';
import { getState } from './vocabulary.js';

/**
 * @param {string} text the book's clean text
 * @param {{ limit?: number }} [opts]
 * @returns {{ word: string, count: number, sentence: string }[]}
 */
export function buildDeck(text, { limit = 50 } = {}) {
  const tokens = tokenize(text);
  const getSentence = buildSentenceLookup(text, tokens);

  const seen = new Map(); // word -> { count, firstWordIndex }
  let wordIndex = -1; // index among word tokens (aligns with buildSentenceLookup)
  for (const t of tokens) {
    if (!t.isWord) continue;
    wordIndex += 1;
    const w = t.normalized;
    if (!w || /^\d+$/.test(w)) continue; // skip empty / pure numbers
    if (getState(w) !== 'unknown') continue; // only words not yet engaged with
    let e = seen.get(w);
    if (!e) {
      e = { count: 0, firstWordIndex: wordIndex };
      seen.set(w, e);
    }
    e.count += 1;
  }

  return [...seen.entries()]
    .map(([word, e]) => ({ word, count: e.count, sentence: getSentence(e.firstWordIndex) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
