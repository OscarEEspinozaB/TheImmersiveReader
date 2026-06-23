// Rendering helpers. The reader is virtualized: only the current page's tokens
// are in the DOM at any time (the whole book never is), so it scales to any size.
// Each word becomes a <span> tagged with its normalized key, global word index,
// and current learning state; whitespace/punctuation become plain text nodes.

import { getState } from '../vocabulary.js';

/**
 * Create a DOM node for a stream item (word, whitespace, or image).
 * @param {(import('../tokenizer.js').Token & { wordIndex?: number }) | { isImage: true, url: string, width?: number, height?: number }} item
 * @returns {Node}
 */
export function makeNode(item) {
  if (item.isImage) {
    const img = document.createElement('img');
    img.className = 'reader__image';
    img.src = item.url;
    if (item.width) img.width = item.width;
    if (item.height) img.height = item.height;
    img.alt = '';
    return img;
  }
  if (item.isWord) {
    const span = document.createElement('span');
    span.className = 'word';
    span.dataset.word = item.normalized;
    span.dataset.state = getState(item.normalized);
    span.dataset.i = String(item.wordIndex);
    span.tabIndex = 0;
    span.textContent = item.text;
    return span;
  }
  return document.createTextNode(item.text);
}

/**
 * Apply a state to every word span sharing the same normalized key (on the
 * currently rendered page). Other pages pick up the state when they render.
 * @param {HTMLElement} root
 * @param {string} normalizedWord
 * @param {import('../vocabulary.js').WordState} state
 */
export function recolorWord(root, normalizedWord, state) {
  const selector = `.word[data-word="${cssEscape(normalizedWord)}"]`;
  for (const el of root.querySelectorAll(selector)) {
    el.dataset.state = state;
  }
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

/**
 * Interleave images into the token stream by character offset. Each image is
 * placed before the first token at/after its anchor offset. Object URLs are
 * created here and collected (in urlSink) for later revocation.
 * @param {import('../tokenizer.js').Token[]} tokens
 * @param {{ start: number, width: number, height: number, blob: Blob }[]} images
 * @param {string[]} urlSink
 */
export function mergeImages(tokens, images, urlSink) {
  if (!images || images.length === 0) return tokens.slice();
  const sorted = [...images].sort((a, b) => a.start - b.start);
  const items = [];
  let k = 0;
  const pushImage = (img) => {
    const url = URL.createObjectURL(img.blob);
    urlSink.push(url);
    items.push({ isImage: true, url, width: img.width, height: img.height });
  };
  for (const token of tokens) {
    while (k < sorted.length && sorted[k].start <= token.start) pushImage(sorted[k++]);
    items.push(token);
  }
  while (k < sorted.length) pushImage(sorted[k++]);
  return items;
}
