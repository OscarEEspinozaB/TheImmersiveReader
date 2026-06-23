// Tokenizer: splits clean text into tokens using the native Intl.Segmenter.
//
// Whitespace and punctuation are preserved as their own (non-word) tokens so the
// text can be re-rendered exactly. Word tokens carry a normalized key used to
// look up their learning state.

import { normalize } from './vocabulary.js';
import { getReadingLang } from './settings.js';

/**
 * @typedef {Object} Token
 * @property {string} text       original surface form, e.g. "Harry's"
 * @property {string} normalized vocabulary key, e.g. "harry's" (empty for non-words)
 * @property {boolean} isWord    false for whitespace / punctuation chunks
 * @property {number} start      character offset of this token in the source text
 */

/**
 * @param {string} text clean text string
 * @returns {Token[]}
 */
export function tokenize(text) {
  const segmenter = new Intl.Segmenter(getReadingLang(), { granularity: 'word' });
  const tokens = [];
  for (const seg of segmenter.segment(text)) {
    const isWord = seg.isWordLike === true;
    tokens.push({
      text: seg.segment,
      normalized: isWord ? normalize(seg.segment) : '',
      isWord,
      start: seg.index,
    });
  }
  return tokens;
}
