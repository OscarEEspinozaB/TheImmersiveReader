// Local dictionary provider.
//
// First link in the chain: an offline, instant lookup. It answers from two
// offline sources before any network/AI provider is tried:
//
// 1. The contraction registry (contractions.js) — for "didn't", "you'd", "it's"…
//    it returns a plain-English breakdown ("Contraction: did + not."). This is the
//    single source of truth for contractions, shared with the reader and stats.
// 2. `entries` — an extensible map for any other curated/cached explanations.
//    Currently empty; can later hold a bundled word list.

import { explain as explainContraction } from '../contractions.js';

/** @type {Map<string, string>} */
const entries = new Map();

/**
 * @param {string} word surface or normalized word
 * @returns {Promise<import('./index.js').Definition | null>}
 */
export async function lookupLocal(word) {
  const contraction = explainContraction(word);
  if (contraction) return { explanation: contraction, source: 'contraction' };
  const hit = entries.get(word);
  return hit ? { explanation: hit, source: 'local' } : null;
}
