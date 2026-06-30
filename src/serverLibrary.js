// Client for the home library book store (server/routes/books.js). The book store
// lives in the same home-server process as the dictionary KB, so it reuses the
// configured server URL (Settings → "Home server URL").
//
// Flow: a book is processed once on a device, exported to a `.tir` (src/tir.js),
// and uploaded here; any other device browses the catalog and downloads the
// `.tir`, importing it into its local library. Reading position and vocabulary are
// NOT part of this — they sync separately (a later milestone).

import { getKbUrl } from './settings.js';
import { exportBookToBlob, importTir } from './tir.js';

const PROBE_TIMEOUT = 1500; // ms — the server is on the LAN; slow == effectively absent
const LIST_TIMEOUT = 4000;

/** The configured home-server base URL (empty when not set up). */
function base() {
  return getKbUrl();
}

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Whether the home server is configured and reachable. */
export async function isServerAvailable() {
  const b = base();
  if (!b) return false;
  try {
    const res = await fetchWithTimeout(`${b}/health`, {}, PROBE_TIMEOUT);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Upload a local book to the server library. Idempotent: re-uploading identical
 * content returns the existing entry (`duplicate: true`).
 * @param {string} localId the book id in the local IndexedDB library
 * @returns {Promise<{ id: string, title: string, duplicate?: boolean }>}
 */
export async function uploadBook(localId) {
  const b = base();
  if (!b) throw new Error('No home server URL configured (Settings).');
  const { blob } = await exportBookToBlob(localId);
  const res = await fetch(`${b}/books`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob,
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => null);
    throw new Error(msg?.error || `Upload failed (${res.status}).`);
  }
  return res.json();
}

/**
 * List the server catalog.
 * @param {{ lang?: string, q?: string }} [opts]
 * @returns {Promise<Array<{id,title,author,lang,size,hasCover,addedAt,uploadedAt}>>}
 */
export async function listServerBooks({ lang, q } = {}) {
  const b = base();
  if (!b) return [];
  const params = new URLSearchParams();
  if (lang) params.set('lang', lang);
  if (q) params.set('q', q);
  let res;
  try {
    res = await fetchWithTimeout(`${b}/books?${params}`, {}, LIST_TIMEOUT);
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data = await res.json();
  return data.books || [];
}

/**
 * Download a server book and import it into the local library. If the book is
 * already in the local library (same stable id), nothing is added (`duplicate`).
 * @param {string} serverId
 * @returns {Promise<{ id: string, title: string, duplicate: boolean }>}
 */
export async function downloadServerBook(serverId) {
  const b = base();
  if (!b) throw new Error('No home server URL configured (Settings).');
  const res = await fetch(`${b}/books/${serverId}/content`);
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  const blob = await res.blob();
  return importTir(blob);
}

/** Remove a book from the server library. */
export async function deleteServerBook(serverId) {
  const b = base();
  if (!b) throw new Error('No home server URL configured (Settings).');
  const res = await fetch(`${b}/books/${serverId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Delete failed (${res.status}).`);
  return res.json().catch(() => ({}));
}

/** URL of a server book's cover image (or null when not configured). */
export function serverCoverUrl(serverId) {
  const b = base();
  return b ? `${b}/books/${serverId}/cover` : null;
}
