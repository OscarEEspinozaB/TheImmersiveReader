// Word segmentation shared by the reader's tokenizer (src/tokenizer.js) and the
// server-side batch builder (server/generate/book.js), so the dictionary is built
// from the SAME words the reader makes clickable — no drift between "what I read"
// and "what got a dictionary entry".
//
// Dependency-free on purpose (only Intl.Segmenter + normalize.js), so Node can
// import it: tokenizer.js loads vocabulary.js → settings.js → localStorage, which
// crashes outside the browser.

import { normalize } from './normalize.js';

// English contractive clitics ('t, 'd, 're, 've, 'll, 'm) and curly-apostrophe
// variants. When the segmenter emits them as standalone segments, merge them back
// onto the preceding word so "didn't" / "you'd" stay one entry.
export const CONTR_CLITIC = /^['‘’ʼ](?:t|d|re|ve|ll|m)$/i;

// Standalone possessive 's — surface text only, never a vocabulary word.
export const POSSESSIVE_CLITIC = /^['‘’ʼ]s$/i;

// A word-like segment that is purely a number ("17", "1945", "1,000", "3:30") is
// not vocabulary. Segments mixing letters and digits ("covid19", "mp3", "1st") stay.
export function isNumeric(segment) {
  return /\p{N}/u.test(segment) && !/\p{L}/u.test(segment);
}

/**
 * Segment text into the stream of normalized vocabulary words, in order (with
 * duplicates). Hyphenated compounds split on the hyphen ("emerald-green" →
 * "emerald", "green"), numbers and possessives drop out, and contractions stay
 * intact ("didn't"). Mirrors the word rules in src/tokenizer.js.
 * @param {string} text
 * @param {string} [lang] reading language for the segmenter, e.g. "en"
 * @returns {string[]} normalized words
 */
export function extractWords(text, lang = 'en') {
  const segmenter = new Intl.Segmenter(lang, { granularity: 'word' });
  const words = [];
  let prevWord = false; // can the next clitic attach to the last emitted word?
  for (const seg of segmenter.segment(text)) {
    const s = seg.segment;
    if (CONTR_CLITIC.test(s) && prevWord) {
      words[words.length - 1] += s; // "didn" + "'t" → "didn't"
      continue;
    }
    if (POSSESSIVE_CLITIC.test(s)) {
      prevWord = false;
      continue;
    }
    if (seg.isWordLike === true && !isNumeric(s)) {
      words.push(s);
      prevWord = true;
    } else {
      prevWord = false;
    }
  }
  return words.map((w) => normalize(w)).filter(Boolean);
}
