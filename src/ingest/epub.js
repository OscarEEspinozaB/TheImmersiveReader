// EPUB reader: an EPUB is a ZIP of XHTML documents + images. We read the spine
// (reading order) from the OPF, extract clean text per document (block elements
// become paragraphs), and anchor inline images by position — producing the same
// { text, images } shape as the PDF reader.

import { unzipSync, strFromU8 } from 'fflate';

const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'ul', 'ol', 'blockquote', 'figure', 'figcaption', 'header', 'footer',
  'table', 'tr', 'hr', 'pre',
]);
const MIN_IMAGE_SIZE = 60;

/**
 * @param {File} file
 * @returns {Promise<{ text: string, images: { start:number, width:number, height:number, blob:Blob }[] }>}
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

  const acc = { text: '' };
  const images = [];
  for (const href of hrefs) {
    const path = resolvePath(opfDir, href);
    const data = files[path];
    if (!data) continue;
    const doc = parseDoc(strFromU8(data), 'text/html');
    if (doc.body) await walk(doc.body, dirname(path), files, acc, images);
    if (!acc.text.endsWith('\n\n')) acc.text += '\n\n';
  }

  const text = acc.text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { text, images };
}

async function walk(node, docDir, files, acc, images) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      acc.text += child.nodeValue.replace(/\s+/g, ' ');
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = child.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style') continue;
    if (tag === 'br') {
      acc.text += '\n';
      continue;
    }
    if (tag === 'img' || tag === 'image') {
      await addImage(child, docDir, files, acc, images);
      continue;
    }

    const block = BLOCK.has(tag);
    if (block && !acc.text.endsWith('\n\n')) acc.text += '\n\n';
    await walk(child, docDir, files, acc, images);
    if (block && !acc.text.endsWith('\n\n')) acc.text += '\n\n';
  }
}

async function addImage(el, docDir, files, acc, images) {
  const src =
    el.getAttribute('src') ||
    el.getAttribute('xlink:href') ||
    el.getAttribute('href');
  if (!src) return;
  const path = resolvePath(docDir, src);
  const data = files[path];
  if (!data) return;
  const blob = new Blob([data], { type: mimeFromExt(path) });
  try {
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    bitmap.close?.();
    if (width >= MIN_IMAGE_SIZE && height >= MIN_IMAGE_SIZE) {
      images.push({ start: acc.text.length, width, height, blob });
    }
  } catch {
    /* unsupported image (e.g. SVG) -> skip */
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
