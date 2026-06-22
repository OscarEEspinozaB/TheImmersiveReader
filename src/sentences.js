// Sentence lookup: given a word index, find the full sentence it belongs to.
// Used to send a word together with its context to the definition layer.

const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

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
