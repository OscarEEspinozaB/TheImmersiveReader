// Definition layer: a swappable provider chain. Each provider takes a word and
// its sentence and returns an explanation, or null if it cannot answer. The
// chain is tried in order of preference and the first answer wins, so the source
// can change without touching the UI.

import { lookupLocal } from './localDict.js';
import { lookupKB, requestKbBuild, reRefineWord, listKbWords, getKbStats } from './kbApi.js';
import { lookupDictionaryApi } from './dictionaryApi.js';
import { decompose } from './ollama.js';
import { serverAiDefine, serverAiExplain, serverAiAvailable, listAiModels } from './serverAi.js';

export { requestKbBuild, reRefineWord, listKbWords, getKbStats, listAiModels };

/**
 * Whether AI explanations are currently available. Context-aware explanations are
 * now brokered + cached by the home server, so this asks the server (is it reachable
 * AND is Ollama up behind it?), not Ollama directly. Cached probe.
 */
export function isAiAvailable() {
  return serverAiAvailable();
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
 * AI definition: context-aware, simple English. Brokered + cached by the home
 * server (generated once, shared across devices); slower on a miss, instant on a
 * cache hit. Resolves to null when no server/AI is available (e.g. away from home).
 * @param {string} word surface form (e.g. "didn't", "Dursley's")
 * @param {string} sentence
 * @param {{ uid?: string, page?: number }} [book] active book context for storage
 * @param {{ force?: boolean }} [opts] force a regeneration (skip + overwrite cache)
 * @returns {Promise<Definition | null>}
 */
export async function getAiDefinition(word, sentence, book, opts) {
  try {
    return await serverAiDefine(word, sentence, book, opts);
  } catch (err) {
    console.warn('AI provider "serverAiDefine" failed:', err);
    return null;
  }
}

/**
 * On-demand AI explanation in the user's native language (rescue for hard cases).
 * Also brokered + cached by the server.
 * @param {string} word surface form
 * @param {string} sentence
 * @param {string} language e.g. "Spanish"
 * @param {{ uid?: string, page?: number }} [book] active book context for storage
 * @param {{ force?: boolean }} [opts] force a regeneration (skip + overwrite cache)
 * @returns {Promise<Definition | null>}
 */
export async function getAiDefinitionInLanguage(word, sentence, language, book, opts) {
  try {
    return await serverAiExplain(word, sentence, language, book, opts);
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
