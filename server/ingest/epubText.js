// Node-side plain-text extraction from an EPUB, for the batch dictionary builder.
//
// Same reason pdfText.js exists: the app's browser ingester (src/ingest/epub.js)
// builds the real reading text — spine order, block-level paragraphs, anchored
// illustrations — but it needs DOMParser, which Node does not have. The builder
// only needs a flat stream of WORDS to know what to refine, so this reads the same
// spine and strips the markup with plain string work. It is deliberately not a
// second ingester: nothing here is ever stored as a book.

import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–', hellip: '…',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

// XHTML → text. Script/style content is dropped whole; block tags become line
// breaks so words never fuse across a paragraph boundary ("end.Start").
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article|blockquote|pre|figure|figcaption|td|th)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const dirname = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// Resolve an href relative to the OPF's own directory, collapsing "../".
function resolve(base, href) {
  const parts = (base ? `${base}/${href}` : href).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

const attr = (tag, name) => tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];

/**
 * Extract an EPUB's reading text as one string, in spine order.
 * @param {string} file path to the .epub
 * @returns {Promise<string>}
 */
export async function extractEpubText(file) {
  const files = unzipSync(new Uint8Array(readFileSync(file)));

  // The OPF is named in META-INF/container.xml; fall back to the first .opf in the
  // archive, which is what a slightly malformed EPUB usually still gets right.
  const container = files['META-INF/container.xml'];
  const opfPath =
    (container && attr(strFromU8(container), 'full-path')) ||
    Object.keys(files).find((f) => f.toLowerCase().endsWith('.opf'));
  if (!opfPath || !files[opfPath]) throw new Error('Not a valid EPUB (no OPF found)');

  const opf = strFromU8(files[opfPath]);
  const opfDir = dirname(opfPath);

  // manifest: id -> href (only the documents; images are of no use to the builder)
  const manifest = {};
  for (const item of opf.match(/<item\b[^>]*>/gi) || []) {
    const id = attr(item, 'id');
    const href = attr(item, 'href');
    if (id && href) manifest[id] = href;
  }

  // spine: the reading order — the same order the reader would meet the words in.
  const spine = (opf.match(/<itemref\b[^>]*>/gi) || [])
    .map((ref) => manifest[attr(ref, 'idref')])
    .filter(Boolean);

  const chapters = [];
  for (const href of spine) {
    const path = resolve(opfDir, href.split('#')[0]);
    const data = files[path];
    if (!data) continue; // a missing chapter is not worth failing the whole book for
    chapters.push(htmlToText(strFromU8(data)));
  }
  if (!chapters.length) throw new Error('EPUB has no readable chapters (empty spine)');
  return chapters.join('\n\n');
}
