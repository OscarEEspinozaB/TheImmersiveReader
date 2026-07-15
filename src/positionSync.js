// Reading-position sync: a book resumes at the same spot when you pick it up on
// another device. It mirrors vocabSync.js — offline-first, per lightweight profile,
// last-write-wins by timestamp — but the unit is a paragraph-anchored position (see
// src/reader/position.js) and the key is the book's TITLE, not its device-local id.
//
// The flow is deliberately small: on opening a book the reader PULLS that title's
// server position (and jumps to it if the server's is newer than what this device
// has); as you read, the new position is PUSHED (debounced). No background reconcile
// loop — a position is only interesting for the book you currently have open.

import { getKbUrl, getProfile } from './settings.js';

const FLUSH_DELAY = 1200; // ms — reading advances continuously; coalesce the pushes
const REQ_TIMEOUT = 5000;

/** Pending pushes, keyed by book title so rapid scrolling coalesces to the latest. */
const outbox = new Map();
let flushTimer = null;

/** The cross-device book key: the title, normalized so trivial spacing/case differ. */
export function bookKey(title) {
  return String(title || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function base() {
  return getKbUrl();
}
function profile() {
  return getProfile();
}
function enabled() {
  return !!base() && !!profile();
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

/**
 * Fetch the server's saved position for a book title.
 * @returns {Promise<{ paragraph: number, word: number, updatedAt: number } | null>}
 */
export async function pullPosition(title) {
  if (!enabled()) return null;
  const book = bookKey(title);
  if (!book) return null;
  try {
    const data = await fetchJson(
      `/position?user=${encodeURIComponent(profile())}&book=${encodeURIComponent(book)}`,
    );
    const got =
      data && typeof data.updatedAt === 'number'
        ? { paragraph: data.paragraph | 0, word: data.word | 0, updatedAt: data.updatedAt }
        : null;
    console.log(`[position] GET user="${profile()}" book="${book}" →`, got || 'none stored');
    return got;
  } catch (err) {
    console.warn(`[position] GET failed user="${profile()}" book="${book}":`, err.message);
    return null; // offline / server down — the local position stands
  }
}

/** Queue the reading position for a book to be pushed to the server (debounced). */
export function pushPosition(title, pos, updatedAt = Date.now()) {
  if (!enabled()) return;
  const book = bookKey(title);
  if (!book) return;
  const entry = { book, paragraph: pos?.paragraph | 0, word: pos?.word | 0, updatedAt };
  outbox.set(book, entry);
  console.log(`[position] queue user="${profile()}"`, entry);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(() => {}); // failures stay queued for the next push
  }, FLUSH_DELAY);
}

async function flush() {
  if (!enabled() || outbox.size === 0) return;
  const batch = [...outbox.values()];
  console.log(`[position] PUT user="${profile()}" →`, batch);
  await fetchJson('/position', {
    method: 'PUT',
    body: JSON.stringify({ user: profile(), positions: batch }),
  });
  // Drop exactly what we sent; positions queued during the request remain.
  for (const p of batch) {
    const cur = outbox.get(p.book);
    if (cur && cur.updatedAt === p.updatedAt) outbox.delete(p.book);
  }
}
