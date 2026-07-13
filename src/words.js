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

// URLs and e-mail addresses are surface text, never vocabulary. Without this the
// segmenter shreds "http://programmer-avec-ocaml.lri.fr/" into five fake red
// "words". Only unambiguous links are matched (scheme://, www., user@host.tld);
// bare domains like "example.com" stay ordinary text — too easy to confuse with
// abbreviations.
const LINK = /(?:\b(?:https?|ftp):\/\/|\bwww\.)\S+|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi;
// Sentence punctuation glued to the end of a link ("see http://x.fr/." or a
// closing paren/quote) belongs to the sentence, not the link.
const LINK_TRAIL = /[.,;:!?…'"’”»›)\]}>]+$/;

/**
 * Split text into link and plain-text chunks; concatenating the chunks yields the
 * original text exactly. Links come out whole so callers keep them out of the
 * vocabulary: the tokenizer turns each into a single non-word token, extractWords
 * skips them entirely.
 * @param {string} text
 * @returns {{ text: string, isLink: boolean, start: number }[]}
 */
export function splitLinks(text) {
  const chunks = [];
  let last = 0;
  LINK.lastIndex = 0;
  for (let m; (m = LINK.exec(text)); ) {
    const link = m[0].replace(LINK_TRAIL, '');
    if (m.index > last) chunks.push({ text: text.slice(last, m.index), isLink: false, start: last });
    chunks.push({ text: link, isLink: true, start: m.index });
    last = m.index + link.length;
    LINK.lastIndex = last; // the trimmed punctuation tail is re-scanned as plain text
  }
  if (last < text.length) chunks.push({ text: text.slice(last), isLink: false, start: last });
  return chunks;
}

/**
 * Segment text into the stream of normalized vocabulary words, in order (with
 * duplicates). Hyphenated compounds split on the hyphen ("emerald-green" →
 * "emerald", "green"), numbers, possessives, URLs and e-mail addresses drop out,
 * and contractions stay intact ("didn't"). Mirrors the word rules in
 * src/tokenizer.js.
 * @param {string} text
 * @param {string} [lang] reading language for the segmenter, e.g. "en"
 * @returns {string[]} normalized words
 */
export function extractWords(text, lang = 'en') {
  const segmenter = new Intl.Segmenter(lang, { granularity: 'word' });
  const words = [];
  for (const chunk of splitLinks(text)) {
    if (chunk.isLink) continue; // URLs/e-mails contribute no vocabulary
    let prevWord = false; // can the next clitic attach to the last emitted word?
    for (const seg of segmenter.segment(chunk.text)) {
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
  }
  return words.map((w) => normalize(w)).filter(Boolean);
}
