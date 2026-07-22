// Sentence lookup: given a word index, find the full sentence it belongs to.
// Used to send a word together with its context to the definition layer.

import { getReadingLang } from './settings.js';

// A trailing period that does NOT end a sentence. `Intl.Segmenter` breaks on every
// one of them, so "Mr. Dursley was the director…" arrives as "Mr." + the rest — a
// "sentence" reading just `Mr.` is useless as context for a definition and nonsense
// to hand a translator. Two families: common abbreviations, and single-letter
// initials ("J.", and the tails of "e.g." / "i.e.").
const ABBREVIATION_END =
  /(?:\b(?:mr|mrs|ms|mx|dr|prof|rev|hon|st|sr|jr|gen|col|capt|lt|sgt|no|vs|etc|approx|dept|est|fig|vol|ed|pp|al|inc|ltd|co)|\b\p{L})\.$/iu;

// A runaway "sentence" (abbreviations chained, or prose with no terminal punctuation)
// must still be flushed: past this length the merge is doing more harm than good.
const MAX_MERGED = 400;

/**
 * Sentence ranges over `text`, with the segmenter's abbreviation breaks merged back
 * together. The single definition of "a sentence" in the app: the context sent with
 * a word to the definition layer, and the unit the reader can ask to translate.
 * @param {string} text
 * @returns {{ start: number, end: number, text: string }[]}
 */
function segmentSentences(text) {
  const segmenter = new Intl.Segmenter(getReadingLang(), { granularity: 'sentence' });
  const out = [];
  let start = -1;
  let buffer = '';
  for (const s of segmenter.segment(text || '')) {
    if (start < 0) start = s.index;
    buffer += s.segment;
    // Hold the break open when the period was an abbreviation's, not a sentence's.
    if (buffer.length < MAX_MERGED && ABBREVIATION_END.test(buffer.trim())) continue;
    out.push({ start, end: start + buffer.length, text: buffer.trim() });
    start = -1;
    buffer = '';
  }
  if (buffer) out.push({ start, end: start + buffer.length, text: buffer.trim() });
  return out;
}

/**
 * Build a function mapping a word index to its sentence.
 * @param {string} text the clean source text
 * @param {import('./tokenizer.js').Token[]} tokens tokens in document order
 * @returns {(wordIndex: number) => string}
 */
export function buildSentenceLookup(text, tokens) {
  // Character offset of each word token, by word index.
  const wordOffsets = [];
  let offset = 0;
  for (const t of tokens) {
    if (t.isWord) wordOffsets.push(offset);
    offset += t.text.length;
  }

  const sentences = segmentSentences(text);

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

/**
 * Build a function mapping a word index to the SPEECH SLICE of its paragraph:
 * the paragraph's text from that word to the end (read-aloud starts where the
 * reader tapped — tap the first word to hear the whole paragraph) plus every
 * word inside the slice with its offsets, so speech boundary events (character
 * offsets into the spoken text) can be mapped back to word spans and
 * highlighted as they are pronounced.
 * @param {string} text the clean source text
 * @param {import('./tokenizer.js').Token[]} tokens tokens in document order
 * @returns {(wordIndex: number) =>
 *   { text: string, words: { start: number, end: number, wordIndex: number }[] } | null}
 */
export function buildParagraphSpeechLookup(text, tokens) {
  const words = []; // { at, len } by word index, offsets into `text`
  let offset = 0;
  for (const t of tokens) {
    if (t.isWord) words.push({ at: offset, len: t.text.length });
    offset += t.text.length;
  }

  const paragraphs = [];
  const re = /[^\n]+/g;
  let m;
  while ((m = re.exec(text))) paragraphs.push({ start: m.index, end: m.index + m[0].length });

  return (wordIndex) => {
    const w = words[wordIndex];
    if (!w) return null;
    const p = paragraphs.find((x) => w.at >= x.start && w.at < x.end);
    if (!p) return null;
    const slice = { text: text.slice(w.at, p.end).trimEnd(), words: [] };
    for (let j = wordIndex; j < words.length && words[j].at < p.end; j++) {
      slice.words.push({
        start: words[j].at - w.at,
        end: words[j].at - w.at + words[j].len,
        wordIndex: j,
      });
    }
    return slice;
  };
}
