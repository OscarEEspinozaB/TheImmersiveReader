// PDF reader: extracts text client-side with pdf.js. PDF is the messiest source,
// so we reconstruct paragraphs from the page GEOMETRY (vertical gaps between lines
// and first-line indentation), not from punctuation — a period can be mid-paragraph
// ("punto y seguido") or end one ("punto y aparte"), so only the layout tells them
// apart. We also drop running headers/footers and de-hyphenate line breaks.

import * as pdfjs from 'pdfjs-dist';
import { OPS } from 'pdfjs-dist';
// Vite resolves this to a URL for the worker bundle.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// Keep real illustrations / decorative titles; drop tiny bullets and hairlines.
// Area-based so wide-but-short ornaments (e.g. a "Chapter 1" graphic) are kept.
const MIN_IMAGE_AREA = 4000; // px²
const MIN_IMAGE_SIDE = 20; // px (drops hairlines)

/**
 * @typedef {import('./index.js').DocImage} DocImage
 * @typedef {import('./index.js').IngestResult} IngestResult
 */

/**
 * @param {File} file
 * @returns {Promise<IngestResult>}
 */
export async function readPdf(file) {
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;

  const pages = [];
  const pageImages = [];
  const figures = []; // vector figures rasterized from a page render (see extractFigures)
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    let lines = extractLines(content.items);
    const raster = await extractImages(page).catch(() => []);
    // A figure the PDF drew as vectors (a plot, a diagram) is not a raster
    // XObject, so extractImages never sees it — it survives only as scattered
    // label text ("y-axis", "15", "•"). When a page has NO raster image but a
    // "Figure N" caption, rasterize the band above the caption instead and drop
    // those stray labels (they now live inside the image). See extractFigures.
    if (raster.length === 0) {
      const fig = await extractFigures(page, lines).catch(() => null);
      if (fig && fig.figures.length) {
        lines = lines.filter((l) => !fig.removed.has(l));
        for (const f of fig.figures) figures.push(f);
      }
    }
    pageImages.push(raster);
    pages.push(lines);
  }
  return normalizePdfText(pages, pageImages, figures);
}

/**
 * Extract embedded raster images from a page (best-effort; skips on any error).
 * @param {import('pdfjs-dist').PDFPageProxy} page
 * @returns {Promise<{ blob: Blob, width: number, height: number }[]>}
 */
async function extractImages(page) {
  const ops = await page.getOperatorList();
  const out = [];
  let found = 0;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const isXObject = fn === OPS.paintImageXObject;
    const isMask = fn === OPS.paintImageMaskXObject;
    const isInline = fn === OPS.paintInlineImageXObject;
    if (!isXObject && !isMask && !isInline) continue;

    try {
      // Inline images carry the object directly; the others carry a name.
      const arg = ops.argsArray[i][0];
      const img = isInline ? arg : await getPageObject(page, arg);
      found += 1;
      const converted = isMask ? await maskToBlob(img) : await imageToBlob(img);
      if (converted) {
        const { width, height } = converted;
        const keep = width * height >= MIN_IMAGE_AREA && Math.min(width, height) >= MIN_IMAGE_SIDE;
        if (keep) out.push(converted);
        else console.info(`pdf image skipped (too small ${width}x${height})`);
      }
    } catch (err) {
      console.info('pdf image skipped (error):', err?.message || err);
    }
  }
  if (found) console.info(`pdf page: ${found} image(s) found, ${out.length} kept`);
  return out;
}

// A figure caption at the START of a line ("Figure 2.5: …", "Fig. 3 …"). A
// mid-sentence "see figure 2.5" is lowercase and not at line start, so it is not
// matched; a body line that happens to open with "Figure" is filtered out later
// by not being centered (see extractFigures).
const CAPTION = /^fig(?:ure|\.)?\s*\d+/i;
const FIG_RENDER_SCALE = 2; // page-render resolution for a crisp figure
const MIN_FIGURE_PX = 40; // ignore a "figure" that trims down to a stray mark

/**
 * Rasterize vector figures on a page. A vector figure (axes, a curve, a tree) is
 * drawn with path operators, not stored as an image, so extractImages never sees
 * it — it survives only as scattered label text. The anchor is its caption.
 *
 * We locate the figure by its VECTOR INK, not by text geometry: text is not part
 * of the path operators, so the drawing's bounding box excludes the surrounding
 * prose and code (a caption sometimes sits just below a code block, e.g. a
 * quadtree value). For each centered "Figure N" caption we take the cluster of
 * path boxes sitting just above it (skipping a decorative full-box callout higher
 * up), render the page, crop the band from that cluster's top down to the caption
 * — which sweeps in the figure's own labels (axis numbers) while leaving the code
 * above untouched — and drop those label lines from the flow.
 * @param {import('pdfjs-dist').PDFPageProxy} page
 * @param {Line[]} lines
 * @returns {Promise<{ figures: { blob: Blob, width: number, height: number, caption: string }[], removed: Set<Line> }>}
 */
async function extractFigures(page, lines) {
  const empty = { figures: [], removed: new Set() };
  if (!lines.length) return empty;
  const vp = page.getViewport({ scale: 1 });
  const H = vp.height;
  const down = (l) => H - l.y; // text baseline, measured from the top of the page
  const bodyLeft = Math.min(...lines.map((l) => l.x));
  const isBody = (l) => l.x <= bodyLeft + 24; // a line starting at the text margin

  // A caption must match AND be centered (indented past the body margin), so a
  // paragraph merely starting with "Figure" is not mistaken for one.
  const captions = lines.filter((l) => CAPTION.test(l.text) && !isBody(l));
  if (!captions.length) return empty;

  const clusters = clusterBoxes(await pathBoxes(page, H)); // vector ink, grouped vertically
  if (!clusters.length) return empty;

  let canvas = null;
  let ctx = null;
  const figures = [];
  const removed = new Set();

  for (const cap of captions) {
    const capTop = down(cap) - (cap.height || 11) * 0.8; // top of the caption glyphs
    // The figure is the ink cluster sitting closest above the caption.
    const cand = clusters.filter((c) => c.bottom <= capTop + 4);
    if (!cand.length) continue;
    const fig = cand.reduce((a, b) => (b.bottom > a.bottom ? b : a));
    if (fig.height < 12) continue; // a stray rule, not a figure

    // Clamp the band's top to just below the nearest text above the ink, so a
    // code block or paragraph immediately above the figure is never swept in.
    const above = lines.filter((l) => down(l) < fig.top - 2);
    const nearestBottom = above.length ? Math.max(...above.map(down)) : 0;
    const top = Math.max(fig.top - 6, nearestBottom + 2);
    const bottom = capTop - 2;
    if (bottom - top < 12) continue;

    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width * FIG_RENDER_SCALE);
      canvas.height = Math.ceil(vp.height * FIG_RENDER_SCALE);
      ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvasContext: ctx,
        viewport: page.getViewport({ scale: FIG_RENDER_SCALE }),
      }).promise;
    }

    const crop = cropInk(canvas, ctx, top * FIG_RENDER_SCALE, bottom * FIG_RENDER_SCALE);
    if (!crop || crop.width < MIN_FIGURE_PX || crop.height < MIN_FIGURE_PX) continue;
    const blob = await new Promise((res) => crop.canvas.toBlob(res, 'image/png'));
    if (!blob) continue;
    figures.push({ blob, width: crop.width, height: crop.height, caption: cap.text });
    for (const l of lines) {
      const y = down(l);
      if (l !== cap && y > top && y < bottom) removed.add(l);
    }
  }
  return { figures, removed };
}

// Compose 2D affine matrices [a,b,c,d,e,f] so a point maps through m1 then m2.
function matMul(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2, a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2, c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2, e1 * b2 + f1 * d2 + f2,
  ];
}

/**
 * Page-space bounding boxes of the drawing paths, in top-down coordinates. Tracks
 * the CTM (save/restore/transform) so a path's user-space extent (its `minMax`
 * arg) maps to the page. Full-column-width THIN paths — running-header rules and
 * the gray rectangles behind code listings — are dropped so they never masquerade
 * as figure ink.
 * @returns {Promise<{ left:number, right:number, top:number, bottom:number, height:number }[]>}
 */
async function pathBoxes(page, H) {
  const vp = page.getViewport({ scale: 1 });
  const wideThreshold = vp.width * 0.6;
  const ops = await page.getOperatorList();
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const boxes = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = matMul(ops.argsArray[i], ctm);
    else if (fn === OPS.constructPath) {
      const mm = ops.argsArray[i][2]; // [minx, miny, maxx, maxy] in user space
      if (!mm) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [ux, uy] of [[mm[0], mm[1]], [mm[2], mm[1]], [mm[0], mm[3]], [mm[2], mm[3]]]) {
        const [px, py] = apply(ctm, ux, uy);
        x0 = Math.min(x0, px); y0 = Math.min(y0, py);
        x1 = Math.max(x1, px); y1 = Math.max(y1, py);
      }
      const w = x1 - x0;
      const h = y1 - y0;
      if (w > wideThreshold && h < 20) continue; // header rule / code-listing band
      boxes.push({ left: x0, right: x1, top: H - y1, bottom: H - y0, height: y1 - y0 });
    }
  }
  return boxes;
}

// Merge boxes that overlap or nearly touch vertically into figure clusters.
function clusterBoxes(boxes, gap = 26) {
  if (!boxes.length) return [];
  const sorted = [...boxes].sort((a, b) => a.top - b.top);
  const clusters = [];
  let cur = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    const b = sorted[i];
    if (b.top <= cur.bottom + gap) {
      cur.left = Math.min(cur.left, b.left);
      cur.right = Math.max(cur.right, b.right);
      cur.bottom = Math.max(cur.bottom, b.bottom);
      cur.top = Math.min(cur.top, b.top);
    } else {
      cur.height = cur.bottom - cur.top;
      clusters.push(cur);
      cur = { ...b };
    }
  }
  cur.height = cur.bottom - cur.top;
  clusters.push(cur);
  return clusters;
}

// Crop a horizontal band [y0, y1] of a rendered page down to its non-white
// bounding box (plus a small margin), on a white ground. Returns null if blank.
function cropInk(src, ctx, y0, y1) {
  const W = src.width;
  y0 = Math.max(0, Math.floor(y0));
  y1 = Math.min(src.height, Math.ceil(y1));
  if (y1 <= y0) return null;
  const data = ctx.getImageData(0, y0, W, y1 - y0).data;
  let minX = W;
  let maxX = -1;
  let minY = y1;
  let maxY = -1;
  for (let row = 0; row < y1 - y0; row++) {
    for (let x = 0; x < W; x++) {
      const p = (row * W + x) * 4;
      if (data[p] < 245 || data[p + 1] < 245 || data[p + 2] < 245) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        const gy = y0 + row;
        if (gy < minY) minY = gy;
        if (gy > maxY) maxY = gy;
      }
    }
  }
  if (maxX < 0) return null; // blank band — the caption had no figure above it
  const pad = 6 * FIG_RENDER_SCALE;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(W - 1, maxX + pad);
  maxY = Math.min(src.height - 1, maxY + pad);
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, w, h);
  octx.drawImage(src, minX, minY, w, h, 0, 0, w, h);
  return { canvas: out, width: w, height: h };
}

// Render a 1-bit image mask (decorative stencil) as a black-on-transparent PNG.
async function maskToBlob(img) {
  if (!img || !img.width || !img.height || !img.data) return null;
  const { width, height, data } = img;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const rowBytes = (width + 7) >> 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = data[y * rowBytes + (x >> 3)] || 0;
      const bit = (byte >> (7 - (x & 7))) & 1;
      if (bit === 0) {
        // sample 0 paints (PDF image mask default); flip this test if it's inverted
        const idx = (y * width + x) * 4;
        rgba[idx + 3] = 255; // opaque black
      }
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return blob ? { blob, width, height } : null;
}

// Promise wrapper around pdf.js's callback-based object store.
function getPageObject(page, name) {
  return new Promise((resolve, reject) => {
    try {
      page.objs.get(name, resolve);
    } catch (err) {
      reject(err);
    }
  });
}

// Draw a pdf.js image object onto a canvas and export a PNG blob.
async function imageToBlob(img) {
  if (!img) return null;
  const width = img.width;
  const height = img.height;
  if (!width || !height) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const bitmap = img.bitmap || (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap ? img : null);
  if (bitmap) {
    ctx.drawImage(bitmap, 0, 0);
  } else if (img.data) {
    const rgba = toRgba(img.data, width, height, img.kind);
    if (!rgba) return null;
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  } else {
    return null;
  }

  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return blob ? { blob, width, height } : null;
}

// Convert pdf.js image data (grayscale / RGB / RGBA) to RGBA for canvas.
function toRgba(data, width, height, kind) {
  const out = new Uint8ClampedArray(width * height * 4);
  // kind: 1 = grayscale 1bpp(packed) — rare; 2 = RGB 24bpp; 3 = RGBA 32bpp.
  if (kind === 3 || data.length === width * height * 4) {
    out.set(data.subarray(0, out.length));
    return out;
  }
  if (kind === 2 || data.length === width * height * 3) {
    for (let i = 0, j = 0; i < width * height; i++) {
      out[j++] = data[i * 3];
      out[j++] = data[i * 3 + 1];
      out[j++] = data[i * 3 + 2];
      out[j++] = 255;
    }
    return out;
  }
  return null; // unsupported packing -> skip
}

/** @typedef {{ text: string, x: number, right: number, y: number, height: number }} Line */

/**
 * Group a page's text items into lines, recording each line's left x, RIGHT
 * edge, baseline y, and font height. Missing inter-word spaces are restored
 * from horizontal gaps. The right edge is what tells a line that fills its
 * measure from one that stops early — the end-of-block signal paragraph
 * grouping needs.
 * @returns {Line[]}
 */
function extractLines(items) {
  const lines = [];
  let parts = [];
  let x = Infinity;
  let right = 0;
  let y = null;
  let height = 0;
  let prev = null;

  const flush = () => {
    const text = parts.join('').replace(/\s+/g, ' ').trim();
    if (text) lines.push({ text, x: x === Infinity ? 0 : x, right, y: y ?? 0, height });
    parts = [];
    x = Infinity;
    right = 0;
    y = null;
    height = 0;
    prev = null;
  };

  for (const item of items) {
    const s = item.str ?? '';
    if (s && item.transform) {
      if (prev && prev.transform) {
        const gap = item.transform[4] - (prev.transform[4] + (prev.width || 0));
        const fontSize = item.transform[0] || item.height || 10;
        const last = parts.length ? parts[parts.length - 1] : '';
        if (gap > fontSize * 0.2 && !last.endsWith(' ') && !s.startsWith(' ')) parts.push(' ');
      }
      parts.push(s);
      x = Math.min(x, item.transform[4]);
      right = Math.max(right, item.transform[4] + (item.width || 0));
      if (y === null) y = item.transform[5];
      height = Math.max(height, item.height || 0);
      prev = item;
    } else if (s) {
      parts.push(s);
    }
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

// A visible bullet glyph opening a paragraph marks a list item. Dashes are
// deliberately NOT bullets here: a leading "–" in a novel is dialogue.
const BULLET = /^[•◦▪‣○·]\s+/;
// Dot leaders running into a page number — the signature of a table-of-contents
// (or index) entry: "2.5 Sieve of Eratosthenes . . . . . . 40".
const TOC_LINE = /\.\s*(\.\s*){2,}\d{1,4}$/;

/**
 * Reconstruct clean prose from the per-page lines, anchoring each page's images
 * to the start of that page's text. Structure is inferred from the same geometry
 * that shapes the paragraphs: a short paragraph set notably larger than the
 * body's median font height reads as a heading; a bullet glyph as a list item.
 * @param {Line[][]} pages
 * @param {{ blob: Blob, width: number, height: number }[][]} [pageImages]
 * @param {{ blob: Blob, width: number, height: number, caption: string }[]} [figures]
 * @returns {IngestResult}
 */
export function normalizePdfText(pages, pageImages = [], figures = []) {
  const cleaned = removeRunningLines(pages);

  /** @type {{ text: string, height: number, lineCount: number }[]} */
  const paragraphs = [];
  /** @type {{ pageIndex: number, paraIndex: number }[]} */
  const imageAt = []; // where each page's images should be inserted

  // The body font height: the median over ALL lines, so headings (few) don't move it.
  const bodyHeight = median(
    cleaned.flatMap((lines) => lines.map((l) => l.height).filter(Boolean)),
  );

  cleaned.forEach((lines, pageIndex) => {
    if ((pageImages[pageIndex] || []).length) {
      imageAt.push({ pageIndex, paraIndex: paragraphs.length });
    }
    const pageParas = groupParagraphs(lines);
    pageParas.forEach((para, j) => {
      if (pageIndex > 0 && j === 0 && paragraphs.length) {
        // A paragraph cut by the page break: merge — but never into/out of a
        // heading or list item, and only when the previous page's last line
        // FILLED its measure (a paragraph interrupted mid-flow always does; a
        // short centered line — a title-page date, a dedication — does not).
        const prev = paragraphs[paragraphs.length - 1];
        if (
          continues(prev.text) && prev.filled &&
          !typeOf(prev, bodyHeight) && !typeOf(para, bodyHeight)
        ) {
          paragraphs[paragraphs.length - 1] = merge(prev, para);
          return;
        }
      }
      paragraphs.push(para);
    });
  });

  // Build the text and record the char offset at each paragraph boundary so we
  // can anchor images (and typed blocks) there. No rewriting afterwards: the
  // lines were already whitespace-collapsed at extraction, and a global replace
  // here would shift every recorded anchor.
  const offsetOfPara = [];
  /** @type {import('./index.js').DocBlock[]} */
  const blocks = [];
  let text = '';
  let prevType = null;
  paragraphs.forEach((para, idx) => {
    // Consecutive list items sit one line apart (a tight list, see index.js).
    const type = typeOf(para, bodyHeight);
    if (idx > 0) text += type === 'li' && prevType === 'li' ? '\n' : '\n\n';
    offsetOfPara[idx] = text.length;
    text += para.text;
    if (type) blocks.push({ start: offsetOfPara[idx], end: text.length, type });
    prevType = type;
  });
  offsetOfPara[paragraphs.length] = text.length; // images after the last paragraph

  /** @type {DocImage[]} */
  const images = [];
  for (const { pageIndex, paraIndex } of imageAt) {
    const start = Math.min(offsetOfPara[paraIndex] ?? text.length, text.length);
    for (const img of pageImages[pageIndex]) {
      images.push({ start, width: img.width, height: img.height, blob: img.blob });
    }
  }

  // A vector figure is anchored at its caption paragraph, so it renders directly
  // above "Figure N: …" — where it sits in the PDF — instead of at the page top.
  for (const fig of figures) {
    const key = captionKey(fig.caption);
    let idx = paragraphs.findIndex((p) => captionKey(p.text) === key);
    if (idx < 0) idx = paragraphs.findIndex((p) => captionKey(p.text).startsWith(key));
    const start = idx >= 0 ? offsetOfPara[idx] : text.length;
    images.push({ start, width: fig.width, height: fig.height, blob: fig.blob });
  }

  return { text, images, blocks };
}

/**
 * Classify a reconstructed paragraph: a heading (by relative font height) or a
 * list item (by bullet glyph); null for body prose.
 * @returns {import('./index.js').BlockType | null}
 */
function typeOf(para, bodyHeight) {
  if (BULLET.test(para.text)) return 'li';
  // A TOC entry renders as a list item (tight, hanging indent) — and being
  // typed also keeps the cross-page merge from stitching entries together.
  if (TOC_LINE.test(para.text)) return 'li';
  if (!bodyHeight || !para.height) return null;
  const short = para.lineCount <= 2 && para.text.length <= 120;
  if (short && para.height >= bodyHeight * 1.55) return 'h1';
  if (short && para.height >= bodyHeight * 1.2) return 'h2';
  return null;
}

/**
 * Split a page's lines into paragraphs using geometry: a new paragraph starts on
 * an extra vertical gap or an indented first line. Wrapped lines are joined.
 * Each paragraph carries its dominant font height, line count, and whether its
 * LAST line filled the measure — the raw material for heading classification
 * (see typeOf) and for the cross-page merge decision.
 * @param {Line[]} lines
 * @returns {{ text: string, height: number, lineCount: number, filled: boolean }[]}
 */
function groupParagraphs(lines) {
  if (lines.length === 0) return [];

  const gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].y - lines[i].y);
  const lineGap = median(gaps.filter((g) => g > 0)) || lines[0].height || 12;
  const bodyLeft = Math.min(...lines.map((l) => l.x));
  const bodyRight = median(lines.map((l) => l.right).filter(Boolean));
  const em = median(lines.map((l) => l.height).filter(Boolean)) || 12;
  const indent = em * 0.5;

  const paras = [];
  let cur = null; // { text, height, lineCount }
  const flush = () => {
    if (cur && cur.text) paras.push(cur);
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let newPara = i === 0;
    if (i > 0) {
      const prev = lines[i - 1];
      const gap = prev.y - line.y;
      // A line that stops well short of the measure ends something; if the next
      // line also DE-indents (a toplevel/code line falling back to body prose),
      // that is a paragraph break even with normal spacing. A first-line-indented
      // novel paragraph never trips this: its indented first line runs full width.
      const prevEndsShort = prev.right < bodyRight - em * 3;
      // TOC entries sit flush, evenly spaced, and end in a folio, never in
      // punctuation — nothing else separates them, so the dot leaders are the
      // boundary: break after one, and before the next (unless the line starts
      // with the leaders themselves — the wrapped tail of a long entry).
      const tocBoundary =
        TOC_LINE.test(prev.text) || (TOC_LINE.test(line.text) && !line.text.startsWith('.'));
      newPara =
        gap > lineGap * 1.5 ||
        line.x > bodyLeft + indent ||
        (prevEndsShort && prev.x > line.x + indent) ||
        tocBoundary;
    }
    const filled = line.right >= bodyRight - em * 3;
    if (newPara || !cur) {
      flush();
      cur = { text: line.text, height: line.height || 0, lineCount: 1, filled };
    } else if (/\p{L}-$/u.test(cur.text)) {
      cur.text = cur.text.slice(0, -1) + line.text; // de-hyphenate across the wrap
      cur.height = Math.min(cur.height, line.height || cur.height);
      cur.lineCount += 1;
      cur.filled = filled;
    } else {
      cur.text += ` ${line.text}`;
      cur.height = Math.min(cur.height, line.height || cur.height);
      cur.lineCount += 1;
      cur.filled = filled;
    }
  }
  flush();
  return paras;
}

// A line's identity for detecting repetition across pages: ignore digits and case.
function lineKey(line) {
  return line.trim().replace(/\s+/g, ' ').replace(/\d+/g, '#').toLowerCase();
}

// A page number sitting at either end of a line ("12 Chapter 2. …", "2.5. The
// Sieve of Eratosthenes 13") — the shape of a running header with its folio.
const EDGE_PAGE_NUM = /^\d{1,4}\s+\S|\S\s+\d{1,4}$/;
// A well-formed Roman numeral, the folio style of front matter ("II", "ix").
const ROMAN_NUM = /^(?=[MDCLXVI])M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/i;

/**
 * Remove running headers/footers and page numbers. The tests, from broadest to
 * narrowest: whole-book repetition (the old rule) for anything; then rules for
 * the FIRST/LAST line of a page WHEN it sits in the header/footer ZONE — the
 * top/bottom margin y that the whole book agrees on (a chapter opening whose
 * first text starts lower on the page is not in the zone, so a bare Roman
 * chapter number survives while a Roman folio at the top margin does not).
 * Running headers change per chapter/section and alternate sides, so they never
 * reach a whole-book threshold: in the zone a short line dies when repeated on
 * ≥3 pages, on ≥2 while carrying a page number at one end, on ONE page when
 * most pages open/close with such a folio-numbered line (this book runs headers
 * everywhere — a section spanning a single page still gets its header removed),
 * or when it IS a bare Roman numeral (front-matter folios: "II", "ix").
 * @param {Line[][]} pages
 * @returns {Line[][]}
 */
function removeRunningLines(pages) {
  const counts = new Map(); // key -> number of PAGES it appears on
  for (const lines of pages) {
    const seen = new Set();
    for (const l of lines) {
      const k = lineKey(l.text);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.floor(pages.length * 0.25));
  const headerish = (l) => {
    const t = l.text.trim();
    return t.length <= 60 && EDGE_PAGE_NUM.test(t);
  };

  // Drop the unambiguous furniture first, so "12" + "Chapter 2. …" split into
  // two lines still leaves the title AT the page edge for the rules below.
  const cleaned = pages.map((lines) =>
    lines.filter((l) => {
      const t = l.text.trim();
      if (!t) return false;
      if (/^\d{1,4}$/.test(t)) return false; // bare page number
      if (/^p\s*a\s*g\s*e\b/i.test(t)) return false; // "Page |" footer (even spaced out)
      return true;
    }),
  );

  // The header/footer zones: where the book's pages typically START and END
  // vertically (PDF y grows upward). Medians, so odd pages don't move them.
  const nonEmpty = cleaned.filter((ls) => ls.length);
  const em = median(nonEmpty.flatMap((ls) => ls.map((l) => l.height).filter(Boolean))) || 12;
  const topY = median(nonEmpty.map((ls) => ls[0].y));
  const bottomY = median(nonEmpty.map((ls) => ls[ls.length - 1].y));
  const inTopZone = (l) => Math.abs(l.y - topY) <= em * 2.5;
  const inBottomZone = (l) => Math.abs(l.y - bottomY) <= em * 2.5;

  const headersEverywhere =
    nonEmpty.filter((ls) => headerish(ls[0]) && inTopZone(ls[0])).length / (nonEmpty.length || 1) > 0.4;
  const footersEverywhere =
    nonEmpty.filter((ls) => headerish(ls[ls.length - 1]) && inBottomZone(ls[ls.length - 1])).length /
      (nonEmpty.length || 1) > 0.4;

  return cleaned.map((lines) =>
    lines.filter((l, idx) => {
      const t = l.text.trim();
      const pageCount = counts.get(lineKey(l.text)) || 0;
      const first = idx === 0 && inTopZone(l);
      const last = idx === lines.length - 1 && inBottomZone(l);
      if ((first || last) && t.length <= 60) {
        if (pageCount >= 3) return false;
        if (ROMAN_NUM.test(t)) return false; // a front-matter folio
        if (headerish(l) && (pageCount >= 2 || (first && headersEverywhere) || (last && footersEverywhere))) {
          return false;
        }
      }
      if (t.length < 80 && pageCount >= threshold) return false;
      return true;
    }),
  );
}

// Normalize a caption for matching a figure to its paragraph (spaces collapsed).
function captionKey(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function continues(paragraphText) {
  return !/[.!?:"”’)]$/.test(paragraphText.trimEnd());
}

/** Join a paragraph cut by a page break (both sides are body prose objects). */
function merge(prev, next) {
  const text = /\p{L}-$/u.test(prev.text)
    ? prev.text.slice(0, -1) + next.text
    : `${prev.text} ${next.text}`;
  return {
    text,
    height: Math.min(prev.height || next.height, next.height || prev.height),
    lineCount: prev.lineCount + next.lineCount,
    filled: next.filled,
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
