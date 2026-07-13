// Contraction registry: maps a contraction's surface form to the component words
// (lemmas) it compresses. A contraction is NOT a vocabulary word itself — it is a
// shorthand for two real words — so it is never stored in the vocabulary store and
// never counted as a unique word. Instead:
//
//   - its reader color is DERIVED from its components (the most urgent state wins:
//     red if any part is unknown, orange if any is learning, white only when all
//     parts are known — so the "red sea" fades as the underlying words are learned);
//   - marking it applies the chosen state to ALL its components at once;
//   - in statistics it expands into its components.
//
// The registry ships with a seed of the common English contractions and GROWS at
// runtime: when an unseen contraction is consulted, the local AI (Ollama) can
// decompose it (see definitions/ollama.js) and the result is added here and
// persisted. Possessives ("Dursley's") are a different case handled by
// normalize() in vocabulary.js; only the genuine 's contractions (it's, he's,
// let's, that's…) live here so they are not mistaken for possessives.

import { normalizeSurface, getState, listEntries, setState } from './vocabulary.js';
import { getReadingLang } from './settings.js';

const STORAGE_KEY = 'immersive-reader.contractions.v1';

/**
 * @typedef {Object} Contraction
 * @property {string[]} parts  component lemmas, in order (e.g. ["did", "not"])
 * @property {string} [note]   nuance shown to the learner (ambiguity, irregularity)
 */

// 'd → would/had and 's → is/has are ambiguous; the parts hold the most common
// reading and the note flags the alternative (the AI resolves it in context).
const D_NOTE = "'d here is short for 'would' or 'had' (the sentence tells which).";
const S_NOTE = "'s here is short for 'is' or 'has' (the sentence tells which).";

/** Seed registry of common English contractions. @type {Record<string, Contraction>} */
const SEED = {
  // not (n't)
  "aren't": { parts: ['are', 'not'] },
  "isn't": { parts: ['is', 'not'] },
  "wasn't": { parts: ['was', 'not'] },
  "weren't": { parts: ['were', 'not'] },
  "haven't": { parts: ['have', 'not'] },
  "hasn't": { parts: ['has', 'not'] },
  "hadn't": { parts: ['had', 'not'] },
  "don't": { parts: ['do', 'not'] },
  "doesn't": { parts: ['does', 'not'] },
  "didn't": { parts: ['did', 'not'] },
  "won't": { parts: ['will', 'not'], note: "Irregular: 'won't' means 'will not'." },
  "wouldn't": { parts: ['would', 'not'] },
  "can't": { parts: ['can', 'not'], note: "From 'cannot'." },
  "couldn't": { parts: ['could', 'not'] },
  "shouldn't": { parts: ['should', 'not'] },
  "mustn't": { parts: ['must', 'not'] },
  "mightn't": { parts: ['might', 'not'] },
  "shan't": { parts: ['shall', 'not'], note: "Irregular: 'shan't' means 'shall not'." },
  "needn't": { parts: ['need', 'not'] },
  "daren't": { parts: ['dare', 'not'] },
  // am ('m)
  "i'm": { parts: ['i', 'am'] },
  // are ('re)
  "you're": { parts: ['you', 'are'] },
  "we're": { parts: ['we', 'are'] },
  "they're": { parts: ['they', 'are'] },
  "who're": { parts: ['who', 'are'] },
  // have ('ve)
  "i've": { parts: ['i', 'have'] },
  "you've": { parts: ['you', 'have'] },
  "we've": { parts: ['we', 'have'] },
  "they've": { parts: ['they', 'have'] },
  "who've": { parts: ['who', 'have'] },
  "would've": { parts: ['would', 'have'] },
  "could've": { parts: ['could', 'have'] },
  "should've": { parts: ['should', 'have'] },
  "might've": { parts: ['might', 'have'] },
  "must've": { parts: ['must', 'have'] },
  // will ('ll)
  "i'll": { parts: ['i', 'will'] },
  "you'll": { parts: ['you', 'will'] },
  "he'll": { parts: ['he', 'will'] },
  "she'll": { parts: ['she', 'will'] },
  "it'll": { parts: ['it', 'will'] },
  "we'll": { parts: ['we', 'will'] },
  "they'll": { parts: ['they', 'will'] },
  "who'll": { parts: ['who', 'will'] },
  "that'll": { parts: ['that', 'will'] },
  "there'll": { parts: ['there', 'will'] },
  // would / had ('d) — ambiguous
  "i'd": { parts: ['i', 'would'], note: D_NOTE },
  "you'd": { parts: ['you', 'would'], note: D_NOTE },
  "he'd": { parts: ['he', 'would'], note: D_NOTE },
  "she'd": { parts: ['she', 'would'], note: D_NOTE },
  "it'd": { parts: ['it', 'would'], note: D_NOTE },
  "we'd": { parts: ['we', 'would'], note: D_NOTE },
  "they'd": { parts: ['they', 'would'], note: D_NOTE },
  "who'd": { parts: ['who', 'would'], note: D_NOTE },
  "that'd": { parts: ['that', 'would'], note: D_NOTE },
  "there'd": { parts: ['there', 'would'], note: D_NOTE },
  // is / has ('s) — ambiguous; let's is special ('s = us)
  "it's": { parts: ['it', 'is'], note: S_NOTE },
  "he's": { parts: ['he', 'is'], note: S_NOTE },
  "she's": { parts: ['she', 'is'], note: S_NOTE },
  "that's": { parts: ['that', 'is'], note: S_NOTE },
  "what's": { parts: ['what', 'is'], note: S_NOTE },
  "who's": { parts: ['who', 'is'], note: S_NOTE },
  "there's": { parts: ['there', 'is'], note: S_NOTE },
  "here's": { parts: ['here', 'is'], note: S_NOTE },
  "where's": { parts: ['where', 'is'], note: S_NOTE },
  "how's": { parts: ['how', 'is'], note: S_NOTE },
  "let's": { parts: ['let', 'us'], note: "'s here is short for 'us' ('let us')." },
};

/** A candidate contraction not yet known: a word with an apostrophe + a clitic. */
const LOOKS_LIKE = /^\p{L}+'(?:t|d|re|ve|ll|m|s)$/u;

/** Runtime registry: seed + AI-learned, merged. @type {Record<string, Contraction>} */
let registry = { ...SEED };
load();

function load() {
  try {
    const learned = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    // Seed wins on conflicts; learned fills the rest.
    registry = { ...learned, ...SEED };
  } catch {
    registry = { ...SEED };
  }
}

function save() {
  try {
    // Persist only the AI-learned entries (those not in the seed) to keep it small
    // and let seed updates flow on upgrade.
    const learned = {};
    for (const [k, v] of Object.entries(registry)) {
      if (!(k in SEED)) learned[k] = v;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(learned));
  } catch (err) {
    console.warn('Could not save contractions:', err);
  }
}

/** Drop all AI-learned contractions, keeping only the built-in seed. */
export function resetLearned() {
  registry = { ...SEED };
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** @param {string} word raw or surface-normalized @returns {Contraction | null} */
export function getContraction(word) {
  return registry[normalizeSurface(word)] || null;
}

/** @param {string} word @returns {string[] | null} component lemmas, or null */
export function parts(word) {
  return getContraction(word)?.parts ?? null;
}

/** @param {string} word @returns {boolean} */
export function isContraction(word) {
  return normalizeSurface(word) in registry;
}

/**
 * Whether a word LOOKS like a contraction we don't know yet (so it is worth
 * asking the AI to decompose it). False for ones already in the registry.
 * @param {string} word
 */
export function isUnknownContraction(word) {
  const key = normalizeSurface(word);
  return !(key in registry) && LOOKS_LIKE.test(key);
}

/**
 * The display state for a contraction: the most urgent of its components'
 * states (unknown > learning > known). Returns null if it is not a contraction.
 * @param {string} word
 * @returns {import('./vocabulary.js').WordState | null}
 */
export function displayState(word) {
  const p = parts(word);
  return p ? aggregateStates(p) : null;
}

/**
 * Aggregate a list of lemmas into one display state (unknown > learning > known).
 * @param {string[]} lemmas
 * @returns {import('./vocabulary.js').WordState}
 */
export function aggregateStates(lemmas) {
  let result = 'known';
  for (const lemma of lemmas) {
    const s = getState(lemma);
    if (s === 'unknown') return 'unknown';
    if (s === 'learning') result = 'learning';
  }
  return result;
}

/** A short, plain-text explanation of a contraction. @returns {string | null} */
export function explain(word) {
  const c = getContraction(word);
  if (!c) return null;
  const base = `Contraction: ${c.parts.join(' + ')}.`;
  return c.note ? `${base} ${c.note}` : base;
}

/**
 * Add (or refine) a contraction learned at runtime — e.g. decomposed by the AI —
 * and persist it. Seed entries are not overwritten.
 * @param {string} word
 * @param {string[]} lemmas
 * @param {string} [note]
 */
export function learnContraction(word, lemmas, note) {
  const key = normalizeSurface(word);
  if (!key || key in SEED) return;
  if (!Array.isArray(lemmas) || lemmas.length < 2) return;
  registry[key] = { parts: lemmas.map((l) => normalizeSurface(l)).filter(Boolean), ...(note ? { note } : {}) };
  save();
}

const RANK = { unknown: 0, learning: 1, known: 2, discarded: 3 };

/**
 * One-time migration: any vocabulary entry whose key is actually a contraction
 * (saved before contractions were decomposed into lemmas) is re-mapped to its
 * component lemmas — each lemma is raised to at least the contraction's state —
 * and the contraction entry is removed so it no longer counts as a unique word.
 * Idempotent: safe to run on every load. Returns how many entries were migrated.
 * @returns {number}
 */
export function migrateVocabularyEntries() {
  let migrated = 0;
  const activeLang = getReadingLang();
  for (const { word, lang, state } of listEntries()) {
    // setState() writes in the active reading language, so only migrate entries
    // that belong to it (the contraction seed is English anyway).
    if (lang && lang !== activeLang) continue;
    const c = registry[word];
    if (!c) continue;
    for (const lemma of c.parts) {
      if (RANK[state] > RANK[getState(lemma)]) setState(lemma, state);
    }
    setState(word, 'unknown'); // the default state removes the contraction entry
    migrated += 1;
  }
  return migrated;
}
