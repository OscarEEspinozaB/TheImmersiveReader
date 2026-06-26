// The library: a collection of books stored in IndexedDB. Metadata (id, title,
// cover, progress) lives in the "books" store so the shelf loads fast; the heavy
// content (text + images) lives in "content", loaded only when a book is opened.

import { idbGet, idbGetAll, idbSet, idbDelete } from './idb.js';

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * @typedef {{ id: string, title: string, addedAt: number, lastOpenedAt: number,
 *   progressWordIndex: number, cover: Blob | null, lang?: string }} BookMeta
 *   `lang` is the book's reading-language code (e.g. "en"); absent on books
 *   added before per-book languages existed (the user is prompted on open).
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
const WORDS_VERSION = 2;

export async function addBook({ title, text, images = [], cover = null, words = null, lang }) {
  const id = uuid();
  const now = Date.now();
  /** @type {BookMeta} */
  const meta = { id, title, addedAt: now, lastOpenedAt: now, progressWordIndex: 0, cover, lang };
  await idbSet('books', id, meta);
  await idbSet('content', id, { text, images });
  if (words) await setBookWords(id, words);
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

export function setBookWords(id, words) {
  return idbSet('bookwords', id, { v: WORDS_VERSION, words });
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

export async function setProgress(id, wordIndex) {
  const book = await idbGet('books', id);
  if (book && book.progressWordIndex !== wordIndex) {
    book.progressWordIndex = wordIndex;
    await idbSet('books', id, book);
  }
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
