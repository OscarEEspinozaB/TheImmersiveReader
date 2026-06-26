// Vocabulary store: maps a normalized word to its learning state and the time it
// reached that state.
//
// State is keyed by the NORMALIZED word (not by position), so marking one
// occurrence recolors every occurrence across all texts. The default state is
// "unknown" (the "red sea") — words absent from the map are unknown on purpose,
// so the user can watch the red fade as their knowledge grows.
//
// Each entry stores { state, at } where `at` is the last-change timestamp (epoch
// ms), which powers the growth charts in the vocabulary dashboard.

/** @typedef {"known" | "learning" | "unknown"} WordState */

import { getReadingLang } from './settings.js';

export const STATES = /** @type {const} */ (['unknown', 'learning', 'known']);
export const DEFAULT_STATE = 'unknown';

// v2 keys entries by language ("<lang>:<normalized>", e.g. "en:harry") so the
// same spelling in two languages ("no", "son", "casa") never collide. The old
// v1 store was language-agnostic and is abandoned on upgrade (start fresh).
const STORAGE_KEY = 'immersive-reader.vocabulary.v2';
const LEGACY_STORAGE_KEY = 'immersive-reader.vocabulary.v1';
// A stored key already carrying a "<lang>:" prefix (en, es, pt-BR, …).
const LANG_PREFIX = /^[a-z]{2}(?:-[A-Z]{2})?:/;

const TRIM_EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
// Curly/typographic apostrophes that EPUB and PDF sources often use instead of
// the plain ASCII apostrophe. Normalizing early means all downstream regexes
// (POSSESSIVE_S, contraction table keys, etc.) only need to handle U+0027.
//   U+2018  ‘  LEFT SINGLE QUOTATION MARK
//   U+2019  ‘  RIGHT SINGLE QUOTATION MARK
//   U+02BC  ʼ  MODIFIER LETTER APOSTROPHE
const CURLY_APOS = /[‘’ʼ]/g;
// Possessive ‘s suffix: "Dursley’s" → "dursley", "Harry’s" → "harry".
// "he’s"→"he", "it’s"→"it" are acceptable conflations for vocabulary learning.
const POSSESSIVE_S = /'s$/; // U+0027 straight apostrophe + s at end

/**
 * Canonical surface form: lowercase, curly apostrophes → straight, edges
 * trimmed, but the apostrophe is KEPT. This is the key used to look a word up in
 * the contraction registry ("didn't", "you'd", "it's" stay intact).
 * @param {string} word
 * @returns {string}
 */
export function normalizeSurface(word) {
  return word
    .toLowerCase()
    .normalize('NFC')
    .replace(CURLY_APOS, "'")
    .replace(TRIM_EDGES, '');
}

/**
 * Normalize a surface word into its vocabulary key (a single lemma). Same as
 * {@link normalizeSurface} but also strips a trailing possessive 's
 * ("Dursley's" → "dursley"). Contractions are handled separately (they map to
 * several lemmas, not one) — see contractions.js — so this is only the key for
 * ordinary words and possessives.
 * @param {string} word
 * @returns {string}
 */
export function normalize(word) {
  return normalizeSurface(word).replace(POSSESSIVE_S, '');
}

/**
 * In-memory store of non-default entries, keyed by the language-scoped key
 * "<lang>:<normalized>" -> { state, at }.
 */
const entries = new Map();

/**
 * Build the language-scoped storage key for a word, using the ACTIVE reading
 * language (the open book's). Returns "" when the word normalizes to nothing.
 * @param {string} word raw or normalized word
 */
function scopedKey(word) {
  const n = normalize(word);
  return n ? `${getReadingLang()}:${n}` : '';
}

/**
 * @param {string} word raw or normalized word
 * @returns {WordState}
 */
export function getState(word) {
  return entries.get(scopedKey(word))?.state ?? DEFAULT_STATE;
}

/**
 * @param {string} word raw or normalized word
 * @param {WordState} state
 */
export function setState(word, state) {
  const key = scopedKey(word);
  if (!key) return;
  if (state === DEFAULT_STATE) {
    entries.delete(key); // only persist non-default states
  } else {
    entries.set(key, { state, at: Date.now() });
  }
  save();
}

/**
 * All non-default entries. The stored key is "<lang>:<word>"; it is split back
 * into a bare `word` (lemma) plus its `lang`, so existing readers that only use
 * `word`/`state`/`at` keep working.
 * @returns {{ word: string, lang: string, state: WordState, at: number }[]}
 */
export function listEntries() {
  return [...entries].map(([key, e]) => {
    const sep = key.indexOf(':');
    const lang = sep > 0 ? key.slice(0, sep) : '';
    const word = sep > 0 ? key.slice(sep + 1) : key;
    return { word, lang, state: e.state, at: e.at };
  });
}

/** @returns {{ known: number, learning: number, total: number }} */
export function counts() {
  let known = 0;
  let learning = 0;
  for (const e of entries.values()) {
    if (e.state === 'known') known += 1;
    else if (e.state === 'learning') learning += 1;
  }
  return { known, learning, total: known + learning };
}

// Coerce a stored/imported value (legacy string OR { state, at }) into an entry.
function toEntry(value, fallbackAt) {
  const state = typeof value === 'string' ? value : value?.state;
  if (!STATES.includes(state) || state === DEFAULT_STATE) return null;
  const at = typeof value === 'object' && Number.isFinite(value.at) ? value.at : fallbackAt;
  return { state, at };
}

/** Load persisted vocabulary into memory (migrates the legacy string format). */
export function load() {
  entries.clear();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    const now = Date.now();
    for (const [key, value] of Object.entries(obj)) {
      const entry = toEntry(value, now);
      if (entry) entries.set(key, entry);
    }
  } catch (err) {
    console.warn('Could not load vocabulary from localStorage:', err);
  }
}

/** Persist the current in-memory vocabulary to localStorage. */
export function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch (err) {
    console.warn('Could not save vocabulary to localStorage:', err);
  }
}

/** A portable backup of the vocabulary (word -> { state, at }). */
export function exportVocabulary() {
  return {
    type: 'immersive-reader-vocabulary',
    version: 2,
    exportedAt: new Date().toISOString(),
    words: Object.fromEntries(entries),
  };
}

/**
 * Merge an exported vocabulary into the store (accepts legacy and new formats).
 * @param {*} data parsed backup object (or a plain word->state/entry map)
 * @param {{ replace?: boolean }} [opts]
 * @returns {number} entries applied
 */
export function importVocabulary(data, { replace = false } = {}) {
  const words = data && typeof data === 'object' ? data.words ?? data : null;
  if (!words || typeof words !== 'object') throw new Error('Invalid vocabulary file');
  if (replace) entries.clear();
  const now = Date.now();
  let applied = 0;
  for (const [rawKey, value] of Object.entries(words)) {
    // New backups carry "<lang>:<word>" keys (kept verbatim); legacy backups are
    // bare words, scoped to the active reading language on import.
    const key = LANG_PREFIX.test(rawKey) ? rawKey : scopedKey(rawKey);
    const entry = toEntry(value, now);
    if (key && entry) {
      entries.set(key, entry);
      applied += 1;
    }
  }
  save();
  return applied;
}

/**
 * Wipe the entire vocabulary (both the v2 store and the abandoned v1 store).
 * Used by the "reset" action when the language model changes.
 */
export function resetAll() {
  entries.clear();
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
