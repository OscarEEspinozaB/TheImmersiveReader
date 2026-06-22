// Session persistence: remember the last opened document (text + images) and the
// reading position so the reader reopens exactly where the user left off.
//
// The document is stored in IndexedDB (it can include image Blobs, too large for
// localStorage). Reading position is a small value kept in localStorage. Position
// is a WORD INDEX (not a page number) so it survives layout changes.

import { idbGet, idbSet } from './idb.js';

const DOC_KEY = 'document.v2';
const PROGRESS_KEY = 'immersive-reader.progress.v1';

/**
 * @param {string} title
 * @param {string} text
 * @param {{ start: number, width: number, height: number, blob: Blob }[]} images
 */
export async function saveDocument(title, text, images = []) {
  try {
    await idbSet(DOC_KEY, { title, text, images });
  } catch (err) {
    console.warn('Could not save document to IndexedDB:', err);
  }
}

/** @returns {Promise<{ title: string, text: string, images: any[] } | null>} */
export async function loadDocument() {
  try {
    return (await idbGet(DOC_KEY)) || null;
  } catch (err) {
    console.warn('Could not load document from IndexedDB:', err);
    return null;
  }
}

/** @param {number} wordIndex */
export function saveProgress(wordIndex) {
  try {
    localStorage.setItem(PROGRESS_KEY, String(wordIndex));
  } catch {
    /* ignore */
  }
}

/** @returns {number} */
export function loadProgress() {
  const v = localStorage.getItem(PROGRESS_KEY);
  const n = v == null ? 0 : parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}
