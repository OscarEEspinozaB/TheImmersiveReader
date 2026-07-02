// Sentence lookup: given a word index, find the full sentence it belongs to.
// Used to send a word together with its context to the definition layer.

import { getReadingLang } from './settings.js';

/**
 * Build a function mapping a word index to its sentence.
 * @param {string} text the clean source text
 * @param {import('./tokenizer.js').Token[]} tokens tokens in document order
 * @returns {(wordIndex: number) => string}
 */
export function buildSentenceLookup(text, tokens) {
  const sentenceSegmenter = new Intl.Segmenter(getReadingLang(), { granularity: 'sentence' });
  // Character offset of each word token, by word index.
  const wordOffsets = [];
  let offset = 0;
  for (const t of tokens) {
    if (t.isWord) wordOffsets.push(offset);
    offset += t.text.length;
  }

  // Sentence ranges over the same text.
  const sentences = [];
  for (const s of sentenceSegmenter.segment(text)) {
    sentences.push({ start: s.index, end: s.index + s.segment.length, text: s.segment.trim() });
  }

  return (wordIndex) => {
    const at = wordOffsets[wordIndex];
    if (at == null) return '';
    for (const s of sentences) {
      if (at >= s.start && at < s.end) return s.text;
    }
    return '';
  };
}

/**
 * Build a function mapping a word index to its whole paragraph. Paragraphs are runs
 * of text between newlines (the ingest layer reconstructs paragraphs as single lines
 * separated by `\n`). Used by the triple-tap "copy paragraph" gesture.
 * @param {string} text the clean source text
 * @param {import('./tokenizer.js').Token[]} tokens tokens in document order
 * @returns {(wordIndex: number) => string}
 */
export function buildParagraphLookup(text, tokens) {
  const wordOffsets = [];
  let offset = 0;
  for (const t of tokens) {
    if (t.isWord) wordOffsets.push(offset);
    offset += t.text.length;
  }

  // Each run of non-newline characters is one paragraph; newlines are separators.
  const paragraphs = [];
  const re = /[^\n]+/g;
  let m;
  while ((m = re.exec(text))) {
    paragraphs.push({ start: m.index, end: m.index + m[0].length, text: m[0].trim() });
  }

  return (wordIndex) => {
    const at = wordOffsets[wordIndex];
    if (at == null) return '';
    for (const p of paragraphs) {
      if (at >= p.start && at < p.end) return p.text;
    }
    return '';
  };
}
