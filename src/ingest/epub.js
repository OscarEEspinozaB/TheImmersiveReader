// EPUB reader: an EPUB is a ZIP of XHTML documents + images. We read the spine
// (reading order) from the OPF, extract clean text per document, and anchor inline
// images by position — producing the shared { text, images, blocks } shape.
//
// STRUCTURE: the text itself stays flat (tokenizer/positions/sync all key on char
// offsets), and the document's structure travels alongside it as `blocks` — ranges
// of the text annotated with a type (see index.js). Conventions the renderer and
// the .tir format rely on:
//   - a block is separated from its neighbours by "\n\n", EXCEPT consecutive list
//     items, which are separated by a single "\n" (tight lists);
//   - a list item's text begins with its visible marker ("• " or "3. ");
//   - a code block keeps its internal newlines and indentation verbatim.
// Because block/image anchors are char offsets, the text is normalized while it is
// accumulated — never rewritten afterwards (a global replace would shift anchors).

import { unzipSync, strFromU8 } from 'fflate';

// Elements that end a line of prose (generic paragraph boundary → "\n\n").
// Tables (table/tr/td) have dedicated handling in walk() and are not listed here.
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'li', 'ul', 'ol', 'blockquote', 'figure',
  'figcaption', 'header', 'footer', 'hr', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);
// Typed blocks: deeper heading levels flatten to h3 (three visual tiers suffice).
const TYPED = {
  h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h3', h5: 'h3', h6: 'h3',
  pre: 'code', blockquote: 'quote', li: 'li',
};
const MIN_IMAGE_SIZE = 60;

/**
 * @param {File} file
 * @returns {Promise<import('./index.js').IngestResult>}
 */
export async function readEpub(file) {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));

  const opfPath = findOpfPath(files);
  if (!opfPath || !files[opfPath]) throw new Error('Not a valid EPUB (no OPF found)');
  const opfDir = dirname(opfPath);
  const opf = parseDoc(strFromU8(files[opfPath]), 'application/xml');

  // manifest: id -> href
  const manifest = {};
  for (const item of opf.querySelectorAll('manifest > item')) {
    manifest[item.getAttribute('id')] = item.getAttribute('href');
  }
  // spine: ordered hrefs
  const hrefs = [...opf.querySelectorAll('spine > itemref')]
    .map((ref) => manifest[ref.getAttribute('idref')])
    .filter(Boolean);

  const out = new Extractor(files);
  for (const href of hrefs) {
    const path = resolvePath(opfDir, href);
    const data = files[path];
    if (!data) continue;
    const doc = parseDoc(strFromU8(data), 'text/html');
    if (doc.body) await out.walk(doc.body, dirname(path));
    out.paragraphBreak();
  }

  return { text: out.text.trimEnd(), images: out.images, blocks: out.blocks };
}

/** Accumulates text + blocks + images while walking XHTML documents. */
class Extractor {
  constructor(files) {
    this.files = files;
    this.text = '';
    this.blocks = [];
    this.images = [];
    this.block = null; // the open typed block: { start, type }
    this.lastType = null; // type of the block that closed last (tight-list rule)
    this.preDepth = 0;
    this.lists = []; // counters: 0 = unordered, n>0 = next ordered index
    this.cellDepth = 0; // >0 while inside a table cell (its blocks stay inline)
  }

  /** Ensure the accumulated text ends with `sep` (never at the very start). */
  ensureSep(sep) {
    if (this.text === '') return;
    this.text = this.text.replace(/[ \t]+$/, '');
    if (!this.text.endsWith(sep)) {
      this.text = this.text.replace(/\n+$/, '') + sep;
    }
  }

  /** Ensure a single space follows (never at the very start). */
  ensureSpace() {
    if (this.text !== '' && !/\s$/.test(this.text)) this.text += ' ';
  }

  paragraphBreak() {
    // Inside a table cell, block elements (the <div> wrapping each cell, a <p>)
    // are layout, not line breaks — otherwise a LaTeX array "x0 = 0" would split
    // into "x0", "=", "0" on separate lines. Keep the cell on one line.
    if (this.cellDepth > 0) return this.ensureSpace();
    if (this.block) this.ensureSep('\n'); // a break INSIDE a typed block stays one line
    else {
      this.ensureSep('\n\n');
      this.lastType = null; // prose between blocks: the next li starts a NEW list
    }
  }

  /** A table row: each row is its own line (a nested table's stays inline). */
  rowBreak() {
    if (this.cellDepth > 0) this.ensureSpace();
    else this.ensureSep('\n');
  }

  /** The gap between two cells of the same row (nothing before the first). */
  cellSep() {
    if (this.text === '' || /\n$/.test(this.text)) return;
    this.ensureSpace();
  }

  openBlock(type) {
    this.ensureSep(type === 'li' && this.lastType === 'li' ? '\n' : '\n\n');
    this.block = { start: this.text.length, type };
  }

  closeBlock() {
    this.text = this.text.replace(/\s+$/, '');
    const { start, type } = this.block;
    this.block = null;
    if (this.text.length > start) {
      this.blocks.push({ start, end: this.text.length, type });
    }
    this.lastType = type;
  }

  /** The "• " / "3. " marker a list item starts with. */
  listMarker() {
    const n = this.lists[this.lists.length - 1];
    if (n > 0) {
      this.lists[this.lists.length - 1] = n + 1;
      return `${n}. `;
    }
    return '• ';
  }

  pushText(value) {
    if (this.preDepth > 0) {
      let s = value.replace(/\r\n?/g, '\n');
      // No leading blank lines right at the block start (<pre> often opens with \n).
      if (this.block && this.text.length === this.block.start) s = s.replace(/^\n+/, '');
      this.text += s;
      return;
    }
    let s = value.replace(/\s+/g, ' ');
    if (s.startsWith(' ') && (this.text === '' || /\s$/.test(this.text))) s = s.slice(1);
    this.text += s;
  }

  async walk(node, docDir) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        this.pushText(child.nodeValue);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = child.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style') continue;
      if (tag === 'br') {
        if (this.cellDepth > 0) this.ensureSpace();
        else this.text += '\n';
        continue;
      }
      if (tag === 'img' || tag === 'image') {
        await this.addImage(child, docDir);
        continue;
      }

      if (tag === 'ul' || tag === 'ol') {
        this.paragraphBreak();
        this.lists.push(tag === 'ol' ? 1 : 0);
        await this.walk(child, docDir);
        this.lists.pop();
        this.paragraphBreak();
        continue;
      }

      // Tables (incl. LaTeX arrays / equation systems rendered as <table>): the
      // whole table is a block; each row is a line; cells are space-separated.
      // This keeps "x0 = 0 / y0 = 0 / ..." as clean lines instead of exploding
      // every cell onto its own line.
      if (tag === 'table') {
        this.paragraphBreak();
        await this.walk(child, docDir);
        this.paragraphBreak();
        continue;
      }
      if (tag === 'tr') {
        this.rowBreak();
        await this.walk(child, docDir);
        continue;
      }
      if (tag === 'td' || tag === 'th') {
        this.cellSep();
        this.cellDepth += 1;
        await this.walk(child, docDir);
        this.cellDepth -= 1;
        continue;
      }

      const type = TYPED[tag];
      if (tag === 'pre') this.preDepth += 1; // verbatim whitespace anywhere inside
      if (type && !this.block) {
        this.openBlock(type);
        if (type === 'li') this.pushText(this.listMarker());
        await this.walk(child, docDir);
        this.closeBlock();
        if (tag === 'pre') this.preDepth -= 1;
        continue;
      }

      // Any other block element — including a typed one nested inside an open
      // block (li > p, blockquote > h3, nested lists) — is just a line boundary.
      const isBlock = BLOCK.has(tag);
      if (isBlock) this.paragraphBreak();
      if (type === 'li' && this.block) this.pushText(this.listMarker()); // nested list item
      await this.walk(child, docDir);
      if (isBlock) this.paragraphBreak();

      if (tag === 'pre') this.preDepth -= 1;
    }
  }

  async addImage(el, docDir) {
    const src =
      el.getAttribute('src') ||
      el.getAttribute('xlink:href') ||
      el.getAttribute('href');
    if (!src) return;
    const path = resolvePath(docDir, src);
    const data = this.files[path];
    if (!data) return;

    // SVG images are how LaTeX-built EPUBs carry mathematics AND figures, and
    // createImageBitmap can't decode either — they used to vanish. Which of three
    // fates an SVG gets is decided by its SIZE and role:
    //   - a small INLINE formula (√max, ~15pt tall, inside running text) becomes
    //     text from its alt — the reader has no inline images, and dropping a
    //     block mid-sentence would split it ("This is ⌊√ max⌋");
    //   - a DISPLAY equation (its own line) is rasterized, alt as the fallback;
    //   - a FIGURE (a plot, a diagram — large, and its alt is layout junk like
    //     "0x0y11∙2∙22…") is rasterized with NO alt fallback.
    // Size cleanly separates a one-line formula from a figure (tens vs hundreds
    // of points tall), so only a genuinely small SVG is inlined as text.
    if (mimeFromExt(path) === 'image/svg+xml') {
      const svgText = strFromU8(data);
      const alt = cleanMathAlt(el.getAttribute('alt') || '');
      const isDisplay = (el.getAttribute('class') || '').split(/\s+/).includes('math-display');
      const dims = svgSize(svgText);
      const inlineSized = dims && dims.h <= 28 && dims.w <= 140;
      if (!isDisplay && inlineSized && alt && alt !== 'PIC') {
        this.pushText(alt);
        return;
      }
      const png = await svgToPngBlob(svgText).catch(() => null);
      if (png) {
        this.images.push({ start: this.text.length, width: png.width, height: png.height, blob: png.blob });
      } else if (isDisplay && alt && alt !== 'PIC') {
        this.pushText(alt); // an equation we couldn't raster — keep its meaning as text
      }
      return;
    }

    const blob = new Blob([data], { type: mimeFromExt(path) });
    try {
      const bitmap = await createImageBitmap(blob);
      const { width, height } = bitmap;
      bitmap.close?.();
      if (width >= MIN_IMAGE_SIZE && height >= MIN_IMAGE_SIZE) {
        this.images.push({ start: this.text.length, width, height, blob });
      }
    } catch {
      /* unsupported raster image -> skip */
    }
  }
}

// dvisvgm draws a square root's vinculum and other rules as runs of dashes in the
// alt text ("√ ----\n  max"); collapse those and the layout whitespace so an
// inline formula reads as one line ("√ max").
function cleanMathAlt(alt) {
  return alt.replace(/[-_]{2,}/g, ' ').replace(/\s+/g, ' ').trim();
}

// Intrinsic size (in the SVG's own units, ~pt for dvisvgm) from the root's
// width/height, or the viewBox extent as a fallback. Null if neither is present.
function svgSize(svgText) {
  const head = svgText.slice(0, 800);
  const w = head.match(/\bwidth=['"]([\d.]+)/);
  const h = head.match(/\bheight=['"]([\d.]+)/);
  if (w && h) return { w: parseFloat(w[1]), h: parseFloat(h[1]) };
  const vb = head.match(/viewBox=['"][-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)/);
  if (vb) return { w: parseFloat(vb[1]), h: parseFloat(vb[2]) };
  return null;
}

// Rasterize a self-contained SVG (a formula or diagram) to a PNG blob by drawing
// it on a canvas. Formulas ship at document point sizes, so we scale up to stay
// crisp. Returns null on any failure (unsized SVG, tainted canvas) so the caller
// can fall back to the alt text.
async function svgToPngBlob(svgText) {
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = url;
    });
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    const scale = Math.min(4, Math.max(2, 44 / h));
    const pad = 10; // dvisvgm glyphs default to black; a white card keeps the
    // formula legible on every theme (the reader is dark by default) and gives
    // the ink breathing room instead of butting against the edge.
    const width = Math.round(w * scale) + pad * 2;
    const height = Math.round(h * scale) + pad * 2;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, pad, pad, width - pad * 2, height - pad * 2);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? { blob, width, height } : null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function findOpfPath(files) {
  const container = files['META-INF/container.xml'];
  if (container) {
    const xml = parseDoc(strFromU8(container), 'application/xml');
    const rootfile = xml.querySelector('rootfile');
    const full = rootfile?.getAttribute('full-path');
    if (full) return full;
  }
  return Object.keys(files).find((k) => k.toLowerCase().endsWith('.opf'));
}

function parseDoc(str, type) {
  return new DOMParser().parseFromString(str, type);
}

function dirname(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

// Resolve an EPUB href against a base directory, handling ./ and ../ and URL-encoding.
function resolvePath(base, href) {
  const stack = base ? base.split('/') : [];
  for (const part of href.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return decodeURIComponent(stack.join('/'));
}

function mimeFromExt(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  return (
    {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
    }[ext] || 'application/octet-stream'
  );
}
