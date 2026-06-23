// Vocabulary store: maps a normalized word to its learning state.
//
// State is keyed by the NORMALIZED word (not by position), so marking one
// occurrence recolors every occurrence across all texts. The default state is
// "unknown" (the "red sea") — words absent from the map are unknown on purpose,
// so the user can watch the red fade as their knowledge grows.

/** @typedef {"known" | "learning" | "unknown"} WordState */

export const STATES = /** @type {const} */ (['unknown', 'learning', 'known']);
export const DEFAULT_STATE = 'unknown';

const STORAGE_KEY = 'immersive-reader.vocabulary.v1';

// Lowercase and strip surrounding punctuation, keeping internal apostrophes and
// hyphens (so "Harry's" -> "harry's", "well-known" -> "well-known", "—word." -> "word").
const TRIM_EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/**
 * Normalize a surface word into its vocabulary key.
 * @param {string} word
 * @returns {string}
 */
export function normalize(word) {
  return word.toLowerCase().normalize('NFC').replace(TRIM_EDGES, '');
}

/** In-memory store of non-default states only. */
const states = new Map();

/**
 * @param {string} word raw or normalized word
 * @returns {WordState}
 */
export function getState(word) {
  return states.get(normalize(word)) ?? DEFAULT_STATE;
}

/**
 * @param {string} word raw or normalized word
 * @param {WordState} state
 */
export function setState(word, state) {
  const key = normalize(word);
  if (!key) return;
  if (state === DEFAULT_STATE) {
    states.delete(key); // only persist non-default states
  } else {
    states.set(key, state);
  }
  save();
}

/** Load persisted vocabulary from localStorage into memory. */
export function load() {
  states.clear();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    for (const [key, state] of Object.entries(obj)) {
      if (STATES.includes(state) && state !== DEFAULT_STATE) states.set(key, state);
    }
  } catch (err) {
    console.warn('Could not load vocabulary from localStorage:', err);
  }
}

/** Persist the current in-memory vocabulary to localStorage. */
export function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(states)));
  } catch (err) {
    console.warn('Could not save vocabulary to localStorage:', err);
  }
}

/** A portable backup of the vocabulary (word -> state). */
export function exportVocabulary() {
  return {
    type: 'immersive-reader-vocabulary',
    version: 1,
    exportedAt: new Date().toISOString(),
    words: Object.fromEntries(states),
  };
}

/**
 * Merge an exported vocabulary into the store. Returns how many entries were
 * applied. By default it merges (keeps existing words not present in the import).
 * @param {*} data the parsed backup object (or a plain word->state map)
 * @param {{ replace?: boolean }} [opts]
 */
export function importVocabulary(data, { replace = false } = {}) {
  const words = data && typeof data === 'object' ? data.words ?? data : null;
  if (!words || typeof words !== 'object') throw new Error('Invalid vocabulary file');
  if (replace) states.clear();
  let applied = 0;
  for (const [word, state] of Object.entries(words)) {
    const key = normalize(word);
    if (key && STATES.includes(state) && state !== DEFAULT_STATE) {
      states.set(key, state);
      applied += 1;
    }
  }
  save();
  return applied;
}
