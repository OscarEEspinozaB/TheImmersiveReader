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
 * @property {string} normalized vocabulary key, e.g. "harry" for "Harry's" (empty for non-words)
 * @property {boolean} isWord    false for whitespace / punctuation chunks
 * @property {number} start      character offset of this token in the source text
 */

// English contractive clitics ('t, 'd, 're, 've, 'll, 'm) and curly-apostrophe
// variants. If the segmenter emits them as standalone segments, we merge them
// back into the preceding word token so "didn't" stays one vocabulary entry.
const CONTR_CLITIC = /^['‘’ʼ](?:t|d|re|ve|ll|m)$/i;

// Standalone possessive 's — surface text only, not a vocabulary word.
const POSSESSIVE_CLITIC = /^['‘’ʼ]s$/i;

/**
 * @param {string} text clean text string
 * @returns {Token[]}
 */
export function tokenize(text) {
  const segmenter = new Intl.Segmenter(getReadingLang(), { granularity: 'word' });
  const tokens = [];
  for (const seg of segmenter.segment(text)) {
    const isWord = seg.isWordLike === true;
    const prev = tokens.length > 0 ? tokens[tokens.length - 1] : null;

    // Merge contractive clitics onto the preceding word ("didn" + "'t" → "didn't").
    if (CONTR_CLITIC.test(seg.segment) && prev?.isWord) {
      prev.text += seg.segment;
      prev.normalized = normalize(prev.text);
      continue;
    }

    // Possessive 's: keep as plain text, not counted in vocabulary.
    if (POSSESSIVE_CLITIC.test(seg.segment) && prev?.isWord) {
      tokens.push({ text: seg.segment, normalized: '', isWord: false, start: seg.index });
      continue;
    }

    tokens.push({
      text: seg.segment,
      normalized: isWord ? normalize(seg.segment) : '',
      isWord,
      start: seg.index,
    });
  }
  return tokens;
}
