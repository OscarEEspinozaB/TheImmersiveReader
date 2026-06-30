// Definition layer: a swappable provider chain. Each provider takes a word and
// its sentence and returns an explanation, or null if it cannot answer. The
// chain is tried in order of preference and the first answer wins, so the source
// can change without touching the UI.

import { lookupLocal } from './localDict.js';
import { lookupKB, requestKbBuild, listKbWords, getKbStats } from './kbApi.js';
import { lookupDictionaryApi } from './dictionaryApi.js';
import { lookupOllama, explainInLanguage, decompose, isReachable } from './ollama.js';

export { requestKbBuild, listKbWords, getKbStats };

/** Whether the AI (Ollama) is currently reachable. Cached probe. */
export function isAiAvailable() {
  return isReachable();
}

/**
 * @typedef {Object} Definition
 * @property {string} explanation
 * @property {string} source  e.g. "dictionary" | "ollama" | "local" | "kb"
 * @property {boolean} [refined]  for `kb` source: whether the entry is the
 *   AI-refined one (true) or still the raw Kaikki data (false, build pending)
 * @property {import('../definitionsCache.js').KbDetails} [kb]  rich data from the
 *   local KB (part of speech, verb tenses, synonyms, antonyms); only on `kb` source
 */

// The two sources are queried independently so the UI can show the fast one
// (dictionary) immediately and then fill in the AI one (Ollama) when it arrives.

/**
 * Fast, immediate definition: local cache, then the free dictionary API.
 * @param {string} word normalized word
 * @param {string} sentence
 * @returns {Promise<Definition | null>}
 */
export async function getQuickDefinition(word, sentence) {
  for (const provider of [lookupLocal, lookupKB, lookupDictionaryApi]) {
    try {
      const res = await provider(word, sentence);
      if (res && res.explanation) return res;
    } catch (err) {
      console.warn(`Quick provider "${provider.name}" failed:`, err);
    }
  }
  return null;
}

/**
 * AI definition: Ollama — context-aware, simple English. Slower and may be
 * unavailable (e.g. away from home), in which case it resolves to null.
 * @param {string} word normalized word
 * @param {string} sentence
 * @returns {Promise<Definition | null>}
 */
export async function getAiDefinition(word, sentence) {
  try {
    return await lookupOllama(word, sentence);
  } catch (err) {
    console.warn('AI provider "lookupOllama" failed:', err);
    return null;
  }
}

/**
 * On-demand AI explanation in the user's native language (rescue for hard cases).
 * @param {string} word normalized word
 * @param {string} sentence
 * @param {string} language e.g. "Spanish"
 * @returns {Promise<Definition | null>}
 */
export async function getAiDefinitionInLanguage(word, sentence, language) {
  try {
    return await explainInLanguage(word, sentence, language);
  } catch (err) {
    console.warn('AI native-language explanation failed:', err);
    return null;
  }
}

/**
 * Decompose a contraction into its component words (context-aware), to grow the
 * contraction registry. Resolves to null if the AI is unavailable or unsure.
 * @param {string} word the contraction surface form
 * @param {string} sentence
 * @returns {Promise<{ parts: string[], note?: string } | null>}
 */
export async function decomposeContraction(word, sentence) {
  try {
    return await decompose(word, sentence);
  } catch (err) {
    console.warn('AI contraction decomposition failed:', err);
    return null;
  }
}
