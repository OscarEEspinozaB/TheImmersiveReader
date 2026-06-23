// Continuous (scrolling) reader — WINDOWED. The document is split into chunks at
// paragraph boundaries; only chunks near the viewport are rendered into the DOM,
// the rest are collapsed to a spacer of their measured height. This keeps memory
// low and scrolling smooth on huge books.
//
// Trade-off: external Read-Aloud tools only see the loaded window, not the whole
// book (chosen deliberately for performance).
//
// Same public surface as Paginator (content, onChange, currentFirstWordIndex,
// goToWordIndex, refresh, destroy).

import { makeNode, mergeImages } from './render.js';
import { getState } from '../vocabulary.js';

const CHUNK_ITEMS = 600; // min items per chunk (extended to the next paragraph break)
const ROOT_MARGIN = '1200px 0px'; // render chunks within this distance of the viewport
const LINE_PX = 38; // rough line height for the pre-render height estimate
const WORDS_PER_LINE = 9;
const IMAGE_PX = 300;

export class Scroller {
  /**
   * @param {HTMLElement} viewport the scroll container (#reader)
   * @param {import('../tokenizer.js').Token[]} tokens
   * @param {{ start: number, width: number, height: number, blob: Blob }[]} [images]
   */
  constructor(viewport, tokens, images = []) {
    this.viewport = viewport;

    let w = 0;
    for (const t of tokens) {
      if (t.isWord) {
        t.wordIndex = w;
        w += 1;
      }
    }
    this.totalWords = w;

    this._urls = [];
    const items = mergeImages(tokens, images, this._urls);

    this.content = document.createElement('div');
    this.content.className = 'reader__flow';
    viewport.replaceChildren(this.content);

    this.chunks = buildChunks(items, this.content);
    this._wrapperToChunk = new Map(this.chunks.map((c) => [c.wrapper, c]));

    this._io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const chunk = this._wrapperToChunk.get(e.target);
          if (!chunk) continue;
          if (e.isIntersecting) this._render(chunk);
          else this._unload(chunk);
        }
      },
      { root: viewport, rootMargin: ROOT_MARGIN },
    );
    for (const c of this.chunks) this._io.observe(c.wrapper);

    this._onChange = null;
    let throttled = false;
    this._onScroll = () => {
      if (throttled) return;
      throttled = true;
      setTimeout(() => {
        throttled = false;
        this._emit();
      }, 250);
    };
    viewport.addEventListener('scroll', this._onScroll, { passive: true });
  }

  onChange(cb) {
    this._onChange = cb;
    this._emit();
  }

  /** First word at/below the viewport top (exact within the top chunk). */
  currentFirstWordIndex() {
    const vTop = this.viewport.getBoundingClientRect().top;
    let lo = 0;
    let hi = this.chunks.length - 1;
    let idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.chunks[mid].wrapper.getBoundingClientRect().top <= vTop + 1) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const chunk = this.chunks[idx];
    if (chunk.rendered) {
      for (const el of chunk.wrapper.querySelectorAll('.word')) {
        if (el.getBoundingClientRect().top >= vTop - 2) return Number(el.dataset.i) || 0;
      }
    }
    return chunk.firstWord;
  }

  goToWordIndex(index) {
    let idx = 0;
    for (let c = 0; c < this.chunks.length; c++) {
      if (this.chunks[c].firstWord <= index) idx = c;
      else break;
    }
    const chunk = this.chunks[idx];
    this._render(chunk);
    const vTop = this.viewport.getBoundingClientRect().top;
    this.viewport.scrollTop += chunk.wrapper.getBoundingClientRect().top - vTop;
    const el = chunk.wrapper.querySelector(`.word[data-i="${index}"]`);
    if (el) {
      this.viewport.scrollTop += el.getBoundingClientRect().top - this.viewport.getBoundingClientRect().top;
    }
  }

  /** Re-apply learning states to every rendered word (after a vocabulary import). */
  refresh() {
    for (const chunk of this.chunks) {
      if (!chunk.rendered) continue;
      for (const el of chunk.wrapper.querySelectorAll('.word')) {
        el.dataset.state = getState(el.dataset.word);
      }
    }
  }

  next() {}
  prev() {}

  destroy() {
    this._io.disconnect();
    this.viewport.removeEventListener('scroll', this._onScroll);
    for (const url of this._urls) URL.revokeObjectURL(url);
  }

  _render(chunk) {
    if (chunk.rendered) return;
    const frag = document.createDocumentFragment();
    for (const item of chunk.items) frag.appendChild(makeNode(item));
    chunk.wrapper.replaceChildren(frag);
    chunk.wrapper.style.height = ''; // size to content
    chunk.rendered = true;
  }

  _unload(chunk) {
    if (!chunk.rendered) return;
    chunk.height = chunk.wrapper.offsetHeight || chunk.height;
    chunk.wrapper.replaceChildren();
    chunk.wrapper.style.height = `${chunk.height}px`; // keep the space so scroll is stable
    chunk.rendered = false;
  }

  _emit() {
    if (!this._onChange) return;
    const max = this.viewport.scrollHeight - this.viewport.clientHeight;
    const pct = max > 0 ? Math.round((this.viewport.scrollTop / max) * 100) : 0;
    this._onChange({ pct, atStart: true, atEnd: true });
  }
}

/**
 * Split items into chunks that end on a paragraph/line boundary (so block-level
 * chunk wrappers don't introduce mid-paragraph breaks), each with a wrapper div
 * pre-sized to an estimated height.
 */
function buildChunks(items, content) {
  const chunks = [];
  let lastFirstWord = 0;
  let i = 0;
  while (i < items.length) {
    let j = i;
    let count = 0;
    while (j < items.length) {
      const it = items[j];
      j += 1;
      count += 1;
      if (count >= CHUNK_ITEMS && !it.isWord && /\n/.test(it.text)) break;
    }
    const slice = items.slice(i, j);
    i = j;

    let words = 0;
    let imgs = 0;
    let firstWord = -1;
    for (const it of slice) {
      if (it.isImage) imgs += 1;
      else if (it.isWord) {
        words += 1;
        if (firstWord < 0) firstWord = it.wordIndex;
      }
    }
    if (firstWord < 0) firstWord = lastFirstWord;
    lastFirstWord = firstWord;

    const wrapper = document.createElement('div');
    wrapper.className = 'reader__chunk';
    const estimate = Math.max(LINE_PX, Math.ceil(words / WORDS_PER_LINE) * LINE_PX + imgs * IMAGE_PX);
    wrapper.style.height = `${estimate}px`;
    content.appendChild(wrapper);

    chunks.push({ items: slice, wrapper, rendered: false, height: estimate, firstWord });
  }
  return chunks;
}
