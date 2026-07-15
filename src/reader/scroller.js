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
    // Every scrollTop we set (the restore jump AND the per-render compensation below)
    // must be INSTANT. The stylesheet gives .reader--scroll `scroll-behavior: smooth`,
    // which animates programmatic scrolls — that animation races our measurements and
    // makes the position drift. Force instant scrolling for the scroller's lifetime.
    viewport.style.scrollBehavior = 'auto';

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
    // We do our OWN scroll compensation when a windowed chunk grows from its estimated
    // height to its real one (see `_render`), so the browser's native scroll anchoring
    // must be off — otherwise the two fight and over-correct.
    this.content.style.overflowAnchor = 'none';
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

  // Jump so `index` sits at the viewport top. This holds even though the chunks above
  // are still estimated spacers at this instant: as the observer later renders them to
  // their real heights, `_render` compensates scrollTop so the target never drifts.
  goToWordIndex(index) {
    let idx = 0;
    for (let c = 0; c < this.chunks.length; c++) {
      if (this.chunks[c].firstWord <= index) idx = c;
      else break;
    }
    const chunk = this.chunks[idx];
    this._render(chunk);
    const vTop = this.viewport.getBoundingClientRect().top;
    const el = chunk.wrapper.querySelector(`.word[data-i="${index}"]`);
    const target = el || chunk.wrapper;
    this.viewport.scrollTop += target.getBoundingClientRect().top - vTop;
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
    // If this chunk sits entirely ABOVE the viewport, replacing its estimated-height
    // spacer with real content would shove everything below (what the reader is
    // looking at) up or down the page. Measure the height change and cancel it out on
    // scrollTop, so the visible text — and a just-restored position — never moves.
    const vTop = this.viewport.getBoundingClientRect().top;
    const rectBefore = chunk.wrapper.getBoundingClientRect();
    const above = rectBefore.bottom <= vTop;
    const beforeH = rectBefore.height;

    const frag = document.createDocumentFragment();
    for (const item of chunk.items) frag.appendChild(makeNode(item));
    chunk.wrapper.replaceChildren(frag);
    chunk.wrapper.style.height = ''; // size to content
    chunk.rendered = true;

    if (above) {
      const afterH = chunk.wrapper.offsetHeight;
      if (afterH !== beforeH) this.viewport.scrollTop += afterH - beforeH;
    }
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
