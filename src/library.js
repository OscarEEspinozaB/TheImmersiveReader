// The library: a collection of books stored in IndexedDB. Metadata (id, title,
// cover, progress) lives in the "books" store so the shelf loads fast; the heavy
// content (text + images) lives in "content", loaded only when a book is opened.

import { idbGet, idbGetAll, idbSet, idbDelete } from './idb.js';
import { documentCover } from './cover.js';

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * @typedef {{ id: string, title: string, addedAt: number, lastOpenedAt: number,
 *   progressParagraph: number, progressWord: number, progressUpdatedAt: number,
 *   progressWordIndex?: number, cover: Blob | null, coverSource?: 'document'|'uploaded',
 *   coverWidth?: number, coverHeight?: number, lang?: string }} BookMeta
 *   Reading position is stored PARAGRAPH-anchored (`progressParagraph` +
 *   `progressWord`, the Nth word inside it) so it survives moving to another device;
 *   `progressUpdatedAt` drives last-write-wins against the server. `progressWordIndex`
 *   is the legacy field on books saved before this — converted lazily on open.
 *   `lang` is the book's reading-language code (e.g. "en"); absent on books
 *   added before per-book languages existed (the user is prompted on open).
 *   `coverSource` says where the cover came from — the document's own opening image
 *   ('document', the default and what books added before this existed have) or one
 *   the reader uploaded ('uploaded'), which is what makes the swap reversible.
 */

/**
 * Add a book to the library.
 * @param {{ title: string, text: string, images?: any[], cover?: Blob | null,
 *   words?: string[] | null, lang?: string }} book
 * @returns {Promise<string>} the new book id
 */
// Version of the per-book word list. Bumped when the meaning of the list changes
// so stale lists are recomputed. v2: contractions are expanded into their
// component lemmas (so "didn't" counts as "did" + "not"), not stored whole.
// v3: added per-lemma occurrence counts. v4: adds per-sentence word indexes
// (the shelf's "you can read N%" readability badge). v5: URLs/e-mail addresses
// are no longer shredded into fake words (tokenizer treats links as non-words).
const WORDS_VERSION = 5;

export async function addBook({
  id, title, text, images = [], cover = null, coverSource, coverWidth, coverHeight,
  wordData = null, lang, addedAt,
}) {
  // `id`/`addedAt` may be supplied when importing a `.tir` so the book keeps its
  // stable identity across devices (the same logical book is not duplicated). New
  // books generate both. `wordData` is deck.js#bookWordData(text).
  id = id || uuid();
  const now = Date.now();
  /** @type {BookMeta} */
  const meta = {
    id, title, addedAt: addedAt || now, lastOpenedAt: now,
    progressParagraph: 0, progressWord: 0, progressUpdatedAt: 0,
    cover, coverSource: coverSource || (cover ? 'document' : undefined),
    coverWidth, coverHeight, lang,
  };
  await idbSet('books', id, meta);
  await idbSet('content', id, { text, images });
  if (wordData) await setBookWords(id, wordData);
  return id;
}

/**
 * Unique vocabulary lemmas in a book (for per-book stats). Returns undefined when
 * the stored list is missing OR was saved in an older format (a bare array, or an
 * older version), which signals the caller to recompute it from the book's text.
 * @returns {Promise<string[]|undefined>}
 */
export async function getBookWords(id) {
  const rec = await idbGet('bookwords', id);
  if (!rec || Array.isArray(rec) || rec.v !== WORDS_VERSION) return undefined;
  return rec.words;
}

/**
 * The book's full word data: lemmas, occurrence counts, and per-sentence word
 * indexes (see deck.js#bookWordData). Undefined when missing/stale — the caller
 * recomputes from the text (same contract as getBookWords).
 * @returns {Promise<{ words: string[], counts: number[], sentences: number[][] }|undefined>}
 */
export async function getBookWordData(id) {
  const rec = await idbGet('bookwords', id);
  if (!rec || Array.isArray(rec) || rec.v !== WORDS_VERSION || !rec.sentences) return undefined;
  return { words: rec.words, counts: rec.counts, sentences: rec.sentences };
}

/** Persist a book's word data (`data` is deck.js#bookWordData's shape). */
export function setBookWords(id, data) {
  return idbSet('bookwords', id, { v: WORDS_VERSION, ...data });
}

/** @returns {Promise<BookMeta[]>} books, most recently opened first */
export async function listBooks() {
  const all = await idbGetAll('books');
  return all.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
}

/** @returns {Promise<BookMeta | undefined>} */
export function getBook(id) {
  return idbGet('books', id);
}

/** Titles compare as a reader reads them: case and stray spacing are not identity. */
const titleKey = (title) => (title || '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * A book already on the shelf with this title, if any.
 *
 * The stable id from the `.tir` manifest is the FIRST test for "do I already have
 * this" — but it only catches copies that descend from the same original. The same
 * book ingested from the PDF on one device and downloaded from the server on
 * another are two different ids and, to the shelf, two books with the same name.
 * The title is what the reader sees, so it is what identity has to fall back on.
 * @param {string} title
 * @returns {Promise<BookMeta | undefined>}
 */
export async function findBookByTitle(title) {
  const key = titleKey(title);
  if (!key) return undefined;
  return (await idbGetAll('books')).find((b) => titleKey(b.title) === key);
}

/** @returns {Promise<{ text: string, images: any[] } | undefined>} */
export function getBookContent(id) {
  return idbGet('content', id);
}

/**
 * Set a book's reading language. Clears the cached word list so it is recomputed
 * under the new language (tokenization is language-dependent).
 * @param {string} id
 * @param {string} code a READING_LANGUAGES code, e.g. "es"
 */
export async function setBookLang(id, code) {
  const book = await idbGet('books', id);
  if (book && book.lang !== code) {
    book.lang = code;
    await idbSet('books', id, book);
    await idbDelete('bookwords', id);
  }
}

/**
 * Give a book an uploaded cover (already scaled by cover.js#prepareCover). It
 * replaces whatever cover it had — one cover per book, always — and the book now
 * OPENS with it: the reader anchors it before the first word. The document's own
 * images are untouched, so this is reversible.
 * @param {string} id
 * @param {{ blob: Blob, width: number, height: number }} image
 */
export async function setCover(id, { blob, width, height }) {
  const book = await idbGet('books', id);
  if (!book) return;
  book.cover = blob;
  book.coverSource = 'uploaded';
  book.coverWidth = width;
  book.coverHeight = height;
  await idbSet('books', id, book);
}

/**
 * Undo an upload: go back to the image the document itself opens with (or to no
 * cover at all, for a book that never had one — a generated text cover then).
 * @param {string} id
 */
export async function restoreDocumentCover(id) {
  const book = await idbGet('books', id);
  if (!book) return;
  const content = await idbGet('content', id);
  const original = documentCover(content?.images);
  book.cover = original?.blob || null;
  book.coverSource = original ? 'document' : undefined;
  book.coverWidth = undefined;
  book.coverHeight = undefined;
  await idbSet('books', id, book);
}

export async function renameBook(id, title) {
  const book = await idbGet('books', id);
  if (book) {
    book.title = title;
    await idbSet('books', id, book);
  }
}

export async function deleteBook(id) {
  await idbDelete('books', id);
  await idbDelete('content', id);
  await idbDelete('bookwords', id);
}

/**
 * Save the reading position (paragraph-anchored) for a book.
 * @param {string} id
 * @param {{ paragraph: number, word: number }} pos
 * @param {number} [updatedAt] wall-clock of the edit (for cross-device last-write-wins)
 */
export async function setProgress(id, pos, updatedAt = Date.now()) {
  const book = await idbGet('books', id);
  if (!book) return;
  const paragraph = pos?.paragraph | 0;
  const word = pos?.word | 0;
  if (book.progressParagraph === paragraph && book.progressWord === word) return;
  book.progressParagraph = paragraph;
  book.progressWord = word;
  book.progressUpdatedAt = updatedAt;
  delete book.progressWordIndex; // superseded by the paragraph-anchored fields
  await idbSet('books', id, book);
}

export async function touchOpened(id) {
  const book = await idbGet('books', id);
  if (book) {
    book.lastOpenedAt = Date.now();
    await idbSet('books', id, book);
  }
}

/** One-time migration of the old single-document record into a library book. */
export async function migrateOldDocument() {
  const old = await idbGet('kv', 'document.v2');
  if (old?.text) {
    const cover = old.images?.[0]?.blob || null;
    await addBook({ title: old.title || 'Untitled', text: old.text, images: old.images || [], cover });
    await idbDelete('kv', 'document.v2');
  }
}
