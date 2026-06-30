// Vocabulary sync: keeps the device's word states in step with the home server,
// per lightweight profile (Settings → "Profile name"). The vocabulary stays
// offline-first — every edit is written locally first — and is then reconciled
// with the server using last-write-wins by timestamp, so progress follows the user
// from one device to another and survives a cleared browser.
//
// - Each local edit is queued and pushed (debounced) so "every change" reaches the
//   server soon after it happens.
// - On startup (and on tab focus) we push anything pending, then pull peers' newer
//   changes and merge them in. Pulls are incremental (since the last sync).

import { getKbUrl, getProfile } from './settings.js';
import { onChange, applyRemoteEntry, listEntries } from './vocabulary.js';

const FLUSH_DELAY = 800; // ms — coalesce rapid marking into one request
const REQ_TIMEOUT = 5000;

/** Pending local edits, keyed by "<lang>:<word>" so rapid re-marks coalesce. */
const outbox = new Map();
let flushTimer = null;
let onRemoteApplied = null; // callback(changes) so the open reader can recolor

function base() {
  return getKbUrl();
}
function profile() {
  return getProfile();
}
function enabled() {
  return !!base() && !!profile();
}

const lastSyncKey = () => `immersive-reader.vocabSync.lastSync.${profile()}`;
function getLastSync() {
  return Number(localStorage.getItem(lastSyncKey())) || 0;
}
function setLastSync(ts) {
  try {
    localStorage.setItem(lastSyncKey(), String(ts));
  } catch {
    /* ignore */
  }
}

async function fetchJson(path, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQ_TIMEOUT);
  try {
    const res = await fetch(`${base()}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Initialize sync: subscribe to edits, do a first reconcile, pull on focus. */
export function initVocabSync({ onRemoteApplied: cb } = {}) {
  onRemoteApplied = cb || null;

  onChange(({ lang, word, state, at }) => {
    if (!lang || !word) return;
    outbox.set(`${lang}:${word}`, { lang, word, state, updatedAt: at });
    scheduleFlush();
  });

  // Re-pull when the user returns to the tab (another device may have changed things).
  window.addEventListener('focus', () => {
    pull().catch(() => {});
  });

  syncNow();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(() => {}); // failures stay queued for the next trigger
  }, FLUSH_DELAY);
}

/** Push queued edits to the server (bulk, last-write-wins on the server side). */
async function flush() {
  if (!enabled() || outbox.size === 0) return;
  const batch = [...outbox.values()];
  await fetchJson('/vocab', {
    method: 'PUT',
    body: JSON.stringify({ user: profile(), entries: batch }),
  });
  // Drop exactly what we sent; edits queued during the request remain.
  for (const e of batch) {
    const cur = outbox.get(`${e.lang}:${e.word}`);
    if (cur && cur.updatedAt === e.updatedAt) outbox.delete(`${e.lang}:${e.word}`);
  }
}

/** Push the entire local vocabulary (used on first sync of a device). */
async function pushAll() {
  if (!enabled()) return;
  const entries = listEntries().map((e) => ({
    lang: e.lang,
    word: e.word,
    state: e.state,
    updatedAt: e.at,
  }));
  if (entries.length === 0) return;
  await fetchJson('/vocab', {
    method: 'PUT',
    body: JSON.stringify({ user: profile(), entries }),
  });
}

/** Pull changes since the last sync and merge them locally (last-write-wins). */
async function pull() {
  if (!enabled()) return;
  const since = getLastSync();
  const data = await fetchJson(`/vocab?user=${encodeURIComponent(profile())}&since=${since}`);
  const changes = [];
  for (const e of data.entries || []) {
    if (applyRemoteEntry(e.lang, e.word, e.state, e.updatedAt)) {
      changes.push({ lang: e.lang, word: e.word, state: e.state });
    }
  }
  if (data.now) setLastSync(data.now);
  if (changes.length && onRemoteApplied) onRemoteApplied(changes);
}

/** Full reconcile: push local state, then pull and merge the server's. */
export async function syncNow() {
  if (!enabled()) return;
  try {
    await pushAll();
    await pull();
  } catch {
    /* offline / server down — try again on the next change or focus */
  }
}
