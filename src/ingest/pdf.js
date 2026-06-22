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
 * @typedef {{ start: number, width: number, height: number, blob: Blob }} DocImage
 * @typedef {{ text: string, images: DocImage[] }} IngestResult
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
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    pages.push(extractLines(content.items));
    pageImages.push(await extractImages(page).catch(() => []));
  }
  return normalizePdfText(pages, pageImages);
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

/** @typedef {{ text: string, x: number, y: number, height: number }} Line */

/**
 * Group a page's text items into lines, recording each line's left x, baseline y,
 * and font height. Missing inter-word spaces are restored from horizontal gaps.
 * @returns {Line[]}
 */
function extractLines(items) {
  const lines = [];
  let parts = [];
  let x = Infinity;
  let y = null;
  let height = 0;
  let prev = null;

  const flush = () => {
    const text = parts.join('').replace(/\s+/g, ' ').trim();
    if (text) lines.push({ text, x: x === Infinity ? 0 : x, y: y ?? 0, height });
    parts = [];
    x = Infinity;
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

/**
 * Reconstruct clean prose from the per-page lines, anchoring each page's images
 * to the start of that page's text.
 * @param {Line[][]} pages
 * @param {{ blob: Blob, width: number, height: number }[][]} [pageImages]
 * @returns {IngestResult}
 */
export function normalizePdfText(pages, pageImages = []) {
  const cleaned = removeRunningLines(pages);

  const paragraphs = [];
  /** @type {{ pageIndex: number, paraIndex: number }[]} */
  const imageAt = []; // where each page's images should be inserted

  cleaned.forEach((lines, pageIndex) => {
    if ((pageImages[pageIndex] || []).length) {
      imageAt.push({ pageIndex, paraIndex: paragraphs.length });
    }
    const pageParas = groupParagraphs(lines);
    pageParas.forEach((para, j) => {
      if (pageIndex > 0 && j === 0 && paragraphs.length) {
        const prev = paragraphs[paragraphs.length - 1];
        if (continues(prev)) {
          paragraphs[paragraphs.length - 1] = merge(prev, para);
          return;
        }
      }
      paragraphs.push(para);
    });
  });

  // Build the text and record the char offset at each paragraph boundary so we
  // can anchor images there.
  const offsetOfPara = [];
  let text = '';
  paragraphs.forEach((para, idx) => {
    offsetOfPara[idx] = text.length;
    text += idx === 0 ? para : `\n\n${para}`;
  });
  offsetOfPara[paragraphs.length] = text.length; // images after the last paragraph

  const cleanText = text.replace(/[ \t]+/g, ' ').trim();

  /** @type {DocImage[]} */
  const images = [];
  for (const { pageIndex, paraIndex } of imageAt) {
    const start = Math.min(offsetOfPara[paraIndex] ?? cleanText.length, cleanText.length);
    for (const img of pageImages[pageIndex]) {
      images.push({ start, width: img.width, height: img.height, blob: img.blob });
    }
  }

  return { text: cleanText, images };
}

/**
 * Split a page's lines into paragraphs using geometry: a new paragraph starts on
 * an extra vertical gap or an indented first line. Wrapped lines are joined.
 * @param {Line[]} lines
 * @returns {string[]}
 */
function groupParagraphs(lines) {
  if (lines.length === 0) return [];

  const gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].y - lines[i].y);
  const lineGap = median(gaps.filter((g) => g > 0)) || lines[0].height || 12;
  const bodyLeft = Math.min(...lines.map((l) => l.x));
  const indent = (median(lines.map((l) => l.height).filter(Boolean)) || 12) * 0.5;

  const paras = [];
  let cur = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let newPara = i === 0;
    if (i > 0) {
      const gap = lines[i - 1].y - line.y;
      newPara = gap > lineGap * 1.5 || line.x > bodyLeft + indent;
    }
    if (newPara) {
      if (cur) paras.push(cur);
      cur = line.text;
    } else if (/\p{L}-$/u.test(cur)) {
      cur = cur.slice(0, -1) + line.text; // de-hyphenate across the wrap
    } else {
      cur += ` ${line.text}`;
    }
  }
  if (cur) paras.push(cur);
  return paras;
}

// A line's identity for detecting repetition across pages: ignore digits and case.
function lineKey(line) {
  return line.trim().replace(/\s+/g, ' ').replace(/\d+/g, '#').toLowerCase();
}

/**
 * Remove running headers/footers (lines repeated on many pages) and page numbers.
 * @param {Line[][]} pages
 * @returns {Line[][]}
 */
function removeRunningLines(pages) {
  const counts = new Map();
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

  return pages.map((lines) =>
    lines.filter((l) => {
      const t = l.text.trim();
      if (!t) return false;
      if (/^\d{1,4}$/.test(t)) return false; // bare page number
      if (/^p\s*a\s*g\s*e\b/i.test(t)) return false; // "Page |" footer (even spaced out)
      if (t.length < 80 && counts.get(lineKey(l.text)) >= threshold) return false;
      return true;
    }),
  );
}

function continues(paragraph) {
  return !/[.!?:"”’)]$/.test(paragraph.trimEnd());
}

function merge(prev, next) {
  if (/\p{L}-$/u.test(prev)) return prev.slice(0, -1) + next;
  return `${prev} ${next}`;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
