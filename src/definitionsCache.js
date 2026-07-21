// Definitions cache: remembers what each word's lookup returned so we never
// re-query the dictionary / AI for a word we've already looked up. Keyed by the
// normalized word (the same key as the vocabulary store).
//
// The dictionary is context-independent, so it is cached by word. The AI is
// CONTEXT-dependent (the explanation fits the sentence), so AI answers are kept as
// a short HISTORY per word — the last few contexts the word appeared in, newest
// first — to build a panorama of how the word is used. Native-language answers are
// cached per word + language + sentence.
//
// NOTE: this is separate from word STATE — caching never changes a word's state.
//
// Storage: localStorage for now. Definitions are small text, but if this grows
// large alongside documents it should move to IndexedDB.

import { getReadingLang } from './settings.js';

const STORAGE_KEY = 'immersive-reader.definitions.v1';

// How many past contexts to remember per word for the AI usage panorama.
export const AI_HISTORY_MAX = 5;

// Cache keys are scoped to the ACTIVE reading language ("<lang>:<word>") so the
// same spelling in two languages ("important", "table", "son") keeps independent
// definitions — mirroring how the vocabulary store is keyed. Entries saved by the
// older language-agnostic format simply become orphaned and are re-fetched.
function scopedKey(word) {
  return `${getReadingLang()}:${word}`;
}

/**
 * @typedef {{ tag: string, form: string }} Inflection
 * @typedef {{ lemma: string, pos: string, tag: string | null, forms: { pos: string, tag: string, form: string }[] }} Family
 * @typedef {{ pos?: string[], formOf?: { lemma: string, pos: string, tags: string[] }, family?: Family, inflections?: Inflection[], synonyms?: string[], antonyms?: string[] }} KbDetails
 * @typedef {{ explanation: string, source: string, pronunciation?: string, refined?: boolean, kb?: KbDetails }} Definition
 * @typedef {{ sentence: string, explanation: string, source: string }} AiContext
 * @typedef {{
 *   dictionary?: Definition,
 *   ai?: AiContext[],                                  // newest first, capped
 *   lang?: Record<string, Record<string, Definition>> // language -> sentence -> def
 * }} CacheEntry
 */

/** @type {Record<string, CacheEntry>} */
let cache = {};
load();

function load() {
  try {
    cache = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    cache = {};
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch (err) {
    console.warn('Could not save definitions cache:', err);
  }
}

function ensure(word) {
  const k = scopedKey(word);
  if (!cache[k]) cache[k] = {};
  return cache[k];
}

/** @returns {CacheEntry | null} */
export function getCached(word) {
  return cache[scopedKey(word)] || null;
}

export function cacheDictionary(word, def) {
  ensure(word).dictionary = def;
  save();
}

/** The word's AI context history, newest first. @returns {AiContext[]} */
export function getAiList(word) {
  const ai = cache[scopedKey(word)]?.ai;
  // Tolerate data saved by older cache formats (was an object, not an array).
  return Array.isArray(ai) ? ai : [];
}

/** AI answer already stored for this exact context. @returns {AiContext | null} */
export function getAiForSentence(word, sentence) {
  return getAiList(word).find((c) => c.sentence === sentence) || null;
}

/**
 * Add (or refresh) an AI answer for a context. Moves it to the front and caps the
 * history, keeping the most recent contexts.
 */
export function pushAi(word, sentence, def) {
  const entry = ensure(word);
  const list = getAiList(word).filter((c) => c.sentence !== sentence);
  list.unshift({ sentence, explanation: def.explanation, source: def.source });
  entry.ai = list.slice(0, AI_HISTORY_MAX);
  save();
}

/** Native-language answer for a specific context. @returns {Definition | null} */
export function getCachedLang(word, language, sentence) {
  return cache[scopedKey(word)]?.lang?.[language]?.[sentence] || null;
}

export function cacheLang(word, language, sentence, def) {
  const entry = ensure(word);
  entry.lang = entry.lang || {};
  entry.lang[language] = entry.lang[language] || {};
  entry.lang[language][sentence] = def;
  save();
}
