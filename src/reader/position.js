// Reading position as a PARAGRAPH-anchored point — the unit that survives a move to
// another device. The canonical coordinate is the paragraph index, counted from the
// raw source text (a run of non-newline characters), so it does not depend on font,
// screen size, reader mode, or even on the word segmenter agreeing byte-for-byte
// between two browser engines. A secondary `word` offset (the Nth word inside that
// paragraph) refines the landing spot when the text matches; if it does not, the
// paragraph still lands and the word offset clamps to the paragraph's first word.
//
// The readers (Paginator/Scroller) speak "word index" internally; this module is the
// thin translation layer between that and the stored/synced { paragraph, word }.

/** @typedef {{ paragraph: number, word: number }} ReadingPosition */

/** Paragraph spans (non-empty line runs) of the source text, in reading order. */
export function buildParagraphs(text) {
  const paragraphs = [];
  const re = /[^\n]+/g;
  let m;
  while ((m = re.exec(text))) paragraphs.push({ start: m.index, end: m.index + m[0].length });
  return paragraphs;
}

/** Char offset of every word token, in order (index === wordIndex). */
export function wordStartsOf(tokens) {
  const starts = [];
  for (const t of tokens) if (t.isWord) starts.push(t.start);
  return starts;
}

/** Index of the last paragraph whose start is at or before `offset` (binary search). */
function paragraphAt(paragraphs, offset) {
  let lo = 0;
  let hi = paragraphs.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (paragraphs[mid].start <= offset) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return idx;
}

/**
 * A word index (0-based over word tokens) → { paragraph, word }.
 * @returns {ReadingPosition}
 */
export function wordIndexToPosition(wordStarts, paragraphs, wordIndex) {
  if (!paragraphs.length || !wordStarts.length) return { paragraph: 0, word: 0 };
  const i = Math.max(0, Math.min(wordIndex, wordStarts.length - 1));
  const paragraph = paragraphAt(paragraphs, wordStarts[i]);
  const pStart = paragraphs[paragraph].start;
  let word = 0;
  for (let k = i - 1; k >= 0 && wordStarts[k] >= pStart; k--) word += 1;
  return { paragraph, word };
}

/**
 * A { paragraph, word } → word index (0-based over word tokens) to hand a reader.
 * The paragraph is clamped to the document; the word offset is clamped to the words
 * that actually fall inside that paragraph.
 */
export function positionToWordIndex(wordStarts, paragraphs, pos) {
  if (!paragraphs.length || !wordStarts.length) return 0;
  const p = Math.max(0, Math.min(pos?.paragraph | 0, paragraphs.length - 1));
  const { start, end } = paragraphs[p];

  // First word token that lands inside this paragraph.
  let first = -1;
  for (let k = 0; k < wordStarts.length; k++) {
    if (wordStarts[k] >= end) break;
    if (wordStarts[k] >= start) {
      first = k;
      break;
    }
  }
  // Paragraph has no words of its own (e.g. an image): first word at/after its start.
  if (first < 0) {
    for (let k = 0; k < wordStarts.length; k++) if (wordStarts[k] >= start) return k;
    return wordStarts.length - 1;
  }

  // Nudge forward by the word offset, never past the paragraph's last word.
  let idx = first;
  const want = Math.max(0, pos?.word | 0);
  for (let n = 0; n < want && idx + 1 < wordStarts.length && wordStarts[idx + 1] < end; n++) idx += 1;
  return idx;
}
