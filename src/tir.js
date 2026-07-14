// The `.tir` book file format: a self-contained, portable copy of a processed
// book (clean text + anchored images + cover), so a book extracted once can be
// backed up or moved to another device without re-running PDF/EPUB extraction.
//
// Container: a ZIP (via fflate, already a dependency for EPUB) — books carry
// binary images, so a zip beats a base64 JSON blob on size and memory.
//
//   book.tir  (zip)
//     manifest.json   { format, version, title, addedAt, lang, cover, coverMime,
//                       coverSource, coverWidth, coverHeight,
//                       images: [{ file, mime, start, width, height }] }
//     text.txt        the clean reading text
//     images/0.png …  the illustration blobs (one file per anchored image)
//     cover.png       optional cover: the shelf thumbnail, and (when uploaded) the
//                     image the book opens with. `coverSource` says whether it is
//                     the document's own opening image or one the reader chose —
//                     without it, a book that travels as a .tir would forget that
//                     its cover can be taken back.
//
// Reading position and vocabulary are deliberately NOT embedded: vocabulary is
// global (shared across books) and progress is per-device, so the file stays
// portable and shareable. See docs/library.md §3.

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { getBook, getBookContent, addBook } from './library.js';

const FORMAT = 'tir';
const VERSION = 1;

const MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function extFromMime(mime) {
  return MIME_TO_EXT[mime] || 'bin';
}

async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Serialize a stored book into a `.tir` archive.
 * @param {string} id the book id
 * @returns {Promise<{ blob: Blob, filename: string }>}
 */
export async function exportBookToBlob(id) {
  const meta = await getBook(id);
  const content = await getBookContent(id);
  if (!meta || !content) throw new Error('Book not found');

  /** @type {import('fflate').Zippable} */
  const files = {};
  const manifestImages = [];

  const images = content.images || [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img?.blob) continue;
    const mime = img.blob.type || 'image/png';
    const file = `images/${i}.${extFromMime(mime)}`;
    // Images are already compressed — store (level 0) instead of re-deflating.
    files[file] = [await blobBytes(img.blob), { level: 0 }];
    manifestImages.push({ file, mime, start: img.start, width: img.width, height: img.height });
  }

  let cover = null;
  let coverMime = null;
  if (meta.cover) {
    coverMime = meta.cover.type || 'image/png';
    cover = `cover.${extFromMime(coverMime)}`;
    files[cover] = [await blobBytes(meta.cover), { level: 0 }];
  }

  const manifest = {
    format: FORMAT,
    version: VERSION,
    id: meta.id, // stable book identity, preserved on import so it is not duplicated
    title: meta.title,
    addedAt: meta.addedAt,
    lang: meta.lang,
    cover,
    coverMime,
    coverSource: meta.coverSource,
    coverWidth: meta.coverWidth,
    coverHeight: meta.coverHeight,
    images: manifestImages,
  };
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  files['text.txt'] = strToU8(content.text || '');

  const zipped = zipSync(files);
  const blob = new Blob([zipped], { type: 'application/octet-stream' });
  const filename = `${safeName(meta.title) || 'book'}.tir`;
  return { blob, filename };
}

/**
 * Read a `.tir` archive and add it to the library. The book keeps the stable id
 * from its manifest, so importing a book already in the library is a no-op
 * (`duplicate: true`) instead of creating a second copy. Words are recomputed on
 * open (tokenization is language-dependent); vocabulary / progress are not in the file.
 * @param {File|Blob} file
 * @returns {Promise<{ id: string, title: string, duplicate: boolean }>}
 */
export async function importTir(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let files;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('Not a valid .tir file (could not unzip).');
  }

  const manifestRaw = files['manifest.json'];
  if (!manifestRaw) throw new Error('Not a valid .tir file (missing manifest).');
  let manifest;
  try {
    manifest = JSON.parse(strFromU8(manifestRaw));
  } catch {
    throw new Error('Not a valid .tir file (corrupt manifest).');
  }
  if (manifest.format !== FORMAT) {
    throw new Error('Unsupported file: not a .tir book.');
  }
  if (manifest.version > VERSION) {
    throw new Error(`This .tir was made by a newer version (v${manifest.version}); please update.`);
  }

  const title = manifest.title || 'Untitled';

  // Already in the library (same stable id)? Don't create a second copy.
  if (manifest.id && (await getBook(manifest.id))) {
    return { id: manifest.id, title, duplicate: true };
  }

  const text = files['text.txt'] ? strFromU8(files['text.txt']) : '';

  const images = [];
  for (const entry of manifest.images || []) {
    const data = files[entry.file];
    if (!data) continue; // tolerate a missing image rather than failing the whole import
    images.push({
      start: entry.start,
      width: entry.width,
      height: entry.height,
      blob: new Blob([data], { type: entry.mime || 'image/png' }),
    });
  }

  let cover = null;
  if (manifest.cover && files[manifest.cover]) {
    cover = new Blob([files[manifest.cover]], { type: manifest.coverMime || 'image/png' });
  }

  const id = await addBook({
    id: manifest.id, // preserve the stable identity (a fresh uuid if absent / legacy file)
    title,
    text,
    images,
    cover,
    // Legacy files (and books whose cover came from the file itself) have no
    // coverSource: addBook then defaults it to 'document', which is what they are.
    coverSource: manifest.coverSource,
    coverWidth: manifest.coverWidth,
    coverHeight: manifest.coverHeight,
    lang: manifest.lang,
    addedAt: manifest.addedAt,
  });
  return { id, title, duplicate: false };
}

function safeName(name) {
  return (name || '').replace(/[\\/:*?"<>|]+/g, '_').trim();
}
