// Virtualized pagination: the whole book is tokenized in memory, but only the
// CURRENT page's items are rendered into the DOM. A page is the run of items that
// fits the viewport height, found by filling until it overflows. This keeps the
// DOM tiny regardless of book size, so huge books don't freeze the page.
//
// The stream is a mix of text tokens and images, interleaved by position.

import { makeNode, mergeImages } from './render.js';

const RESIZE_DEBOUNCE = 150;

export class Paginator {
  /**
   * @param {HTMLElement} viewport the clipping container (fixed height)
   * @param {(import('../tokenizer.js').Token)[]} tokens
   * @param {{ start: number, width: number, height: number, blob: Blob }[]} [images]
   */
  constructor(viewport, tokens, images = []) {
    this.viewport = viewport;

    // Word index per word token (for marking + restore), assigned before merge.
    let w = 0;
    for (const t of tokens) {
      if (t.isWord) {
        t.wordIndex = w;
        w += 1;
      }
    }
    this.totalWords = w;

    // Object URLs for images; revoked on destroy.
    this._urls = [];
    this.items = mergeImages(tokens, images, this._urls);
    this.total = this.items.length;

    this.content = document.createElement('div');
    this.content.className = 'reader__flow';
    this.viewport.replaceChildren(this.content);

    this.pageStarts = [0]; // item index where each visited page begins
    this.current = 0;
    this.endIndex = 0;
    this._onChange = null;

    this._render();

    this._resizeTimer = null;
    this._resize = () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this.pageStarts = this.pageStarts.slice(0, this.current + 1);
        this._render();
      }, RESIZE_DEBOUNCE);
    };
    window.addEventListener('resize', this._resize);
  }

  /** @param {(s: { pct: number, atStart: boolean, atEnd: boolean }) => void} cb */
  onChange(cb) {
    this._onChange = cb;
    this._emit();
  }

  next() {
    if (this.endIndex >= this.total) return;
    this.current += 1;
    if (this.pageStarts[this.current] === undefined) this.pageStarts[this.current] = this.endIndex;
    this._render();
  }

  prev() {
    if (this.current > 0) {
      this.current -= 1;
      this._render();
      return;
    }
    const start = this.pageStarts[0];
    if (start <= 0) return;
    this.pageStarts.unshift(this._fillBackward(start));
    this._render();
  }

  currentFirstWordIndex() {
    for (let i = this.pageStarts[this.current]; i < this.total; i++) {
      if (this.items[i].isWord) return this.items[i].wordIndex;
    }
    return 0;
  }

  goToWordIndex(wordIndex) {
    let t = 0;
    if (wordIndex > 0) {
      for (let i = 0; i < this.total; i++) {
        const it = this.items[i];
        if (it.isWord && it.wordIndex >= wordIndex) {
          t = i;
          break;
        }
      }
    }
    this.pageStarts = [t];
    this.current = 0;
    this._render();
  }

  /** Re-render the current page (e.g. after vocabulary changed via import). */
  refresh() {
    this._render();
  }

  destroy() {
    window.removeEventListener('resize', this._resize);
    clearTimeout(this._resizeTimer);
    for (const url of this._urls) URL.revokeObjectURL(url);
  }

  _render() {
    const start = this.pageStarts[this.current];
    const c = this.content;
    const maxH = this.viewport.clientHeight;
    c.replaceChildren();

    let i = start;
    for (; i < this.total; i++) {
      c.appendChild(makeNode(this.items[i]));
      if (c.scrollHeight > maxH && i > start) {
        c.removeChild(c.lastChild);
        break;
      }
    }
    this.endIndex = i;
    if (i < this.total) this.pageStarts[this.current + 1] = i;
    this._emit();
  }

  _fillBackward(end) {
    const c = this.content;
    const maxH = this.viewport.clientHeight;
    c.replaceChildren();

    let i = end - 1;
    for (; i >= 0; i--) {
      c.insertBefore(makeNode(this.items[i]), c.firstChild);
      if (c.scrollHeight > maxH) {
        c.removeChild(c.firstChild);
        break;
      }
    }
    c.replaceChildren();
    return Math.max(0, Math.min(i + 1, end - 1));
  }

  _emit() {
    if (!this._onChange) return;
    const start = this.pageStarts[this.current];
    this._onChange({
      pct: this.total ? Math.round((start / this.total) * 100) : 0,
      atStart: this.current === 0 && start === 0,
      atEnd: this.endIndex >= this.total,
    });
  }
}
