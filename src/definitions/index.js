// Definition layer: a swappable provider chain. Each provider takes a word and
// its sentence and returns an explanation, or null if it cannot answer. The
// chain is tried in order of preference and the first answer wins, so the source
// can change without touching the UI.

import { lookupLocal } from './localDict.js';
import { lookupKB, requestKbBuild, reRefineWord, listKbWords, listMissingWords, getKbStats } from './kbApi.js';
import { lookupNativeWiktionary } from './nativeWiktionary.js';
import { lookupFreeDict, freeDictTranslate, lemmaFromFormOf } from './freeDict.js';
import {
  translateText,
  isMlkitAvailable,
  downloadedModels,
  downloadModel,
  modelCodeFor,
} from './mlkitTranslate.js';
import { decompose } from './ollama.js';
import { serverAiDefine, serverAiExplain, serverAiAvailable, listAiModels } from './serverAi.js';

export { requestKbBuild, reRefineWord, listKbWords, listMissingWords, getKbStats, listAiModels };
export { freeDictTranslate, isMlkitAvailable, downloadedModels, downloadModel, modelCodeFor };

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
 * @property {string} source  e.g. "contraction" | "local" | "kb" | "wiktionary" |
 *   "freedict" | "translation" | "mlkit"
 * @property {string} [note]  a secondary line under the answer; today the
 *   translated DEFINITION that goes with a translated word (`mlkit`)
 * @property {string} [pronunciation]  IPA, when the provider carries one (freedict)
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
  for (const provider of [lookupLocal, lookupKB, lookupNativeWiktionary, lookupFreeDict]) {
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
 * The second line under a translated word: what the dictionary says it MEANS, in the
 * reader's language.
 *
 * A dictionary's answer for an inflected form is not a meaning — it is a pointer:
 * "was" resolves to *first-person singular simple past indicative of be*. Translating
 * that sentence is doubly useless: grammar metalanguage teaches a learner nothing
 * about the word, and the small on-device model copies it through untranslated
 * anyway. So when the definition is a form-of pointer, follow it and translate the
 * **lemma** — "was → fue" plus "be → ser" is the answer the reader asked for.
 *
 * @param {string} surface the word as written
 * @param {string} explanation the definition currently shown ('' if none yet)
 * @param {string} language e.g. "Spanish"
 * @returns {Promise<string>} '' when there is nothing worth showing
 */
async function translateMeaning(surface, explanation, language) {
  const text = (explanation || '').trim();
  // Nothing yet, or an "explanation" that is just the word again: repeating the
  // answer back at the reader is noise.
  if (!text || text.toLowerCase() === surface.trim().toLowerCase()) return '';

  const lemma = lemmaFromFormOf(text);
  if (lemma && lemma.toLowerCase() !== surface.trim().toLowerCase()) {
    const translatedLemma = await translateText(lemma, language);
    // Name the lemma: the reader tapped "was", and "ser" is the meaning of "be" —
    // hiding that link would look like a wrong translation of the word they tapped.
    return translatedLemma ? `${lemma} → ${translatedLemma}` : '';
  }
  return (await translateText(text, language)) || '';
}

/**
 * Plain TRANSLATION into the reader's native language — the away-from-home rescue,
 * offered when the AI explanation is unreachable.
 *
 * **What it translates is a teaching decision, not a technical one.** It takes the
 * word and the DICTIONARY'S EXPLANATION of it — never the book's sentence. The goal
 * is a student who understands the words and then reads the English, not one who is
 * handed the book in their own language; translating the sentence in the word bubble
 * would quietly turn every tap into that. Checking a passage is a different, explicit
 * act, and it lives behind its own button — see `translateFragment`.
 *
 * Two providers, best first:
 *   1. `translateText` — on-device (Android), works with no network once its model is
 *      downloaded, answers for ANY word, and can translate the explanation too.
 *   2. `freeDictTranslate` — freedictionaryapi's Wiktionary translation list. Needs
 *      internet, is English-source only, misses common function words (`their` has
 *      none) and can only translate the word itself, but it is all the web build has.
 *
 * @param {string} word normalized word (the dictionary key)
 * @param {string} surface the word as written in the book
 * @param {string} explanation the definition currently shown for it ('' if none yet)
 * @param {string} language e.g. "Spanish" (settings.getLanguage())
 * @returns {Promise<Definition | null>}
 */
export async function translateToNative(word, surface, explanation, language) {
  try {
    // The surface form, not the key: the translator reads real text, and an
    // inflection carries the tense/number the reader is actually looking at.
    // Sequential on purpose — the first call is the one that may download the model,
    // and two parallel downloads of the same pair race for the same files.
    const translatedWord = await translateText(surface || word, language);
    if (translatedWord) {
      return {
        explanation: translatedWord,
        note: await translateMeaning(surface || word, explanation, language),
        source: 'mlkit',
      };
    }
  } catch (err) {
    console.warn('On-device translation failed:', err);
  }
  try {
    const res = await freeDictTranslate(word, language);
    if (!res) console.warn(`No translation for "${word}" in freedictionaryapi (${language})`);
    return res;
  } catch (err) {
    console.warn('Dictionary translation failed:', err);
    return null;
  }
}

/**
 * Translate a PASSAGE — the comprehension check. Separate from `translateToNative`
 * on purpose: this is the reader deliberately asking "did I understand this?" after
 * reading it, from the paragraph bubble, not something a word tap ever does by
 * itself. On-device only; there is no web fallback that can translate free text.
 * @param {string} text the paragraph (or fragment) as written
 * @param {string} language e.g. "Spanish" (settings.getLanguage())
 * @returns {Promise<string | null>}
 */
export async function translateFragment(text, language) {
  try {
    return await translateText(text, language);
  } catch (err) {
    console.warn('Fragment translation failed:', err);
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
