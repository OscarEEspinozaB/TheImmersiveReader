// Free MULTILINGUAL dictionary provider: freedictionaryapi.com (Wiktionary data,
// CC BY-SA 4.0; no API key). Replaces the old English-only dictionaryapi.dev as the
// public fallback in the quick chain — it answers in every reading language the app
// supports (en, es, fr, de, it, pt, ko), and for a NON-English book its definitions
// are written in English, which doubles as a translation into the learning target
// (read a Spanish or Korean word, get an English gloss). It also covers words no
// ordinary dictionary lists (e.g. "Muggle").
//
// It sits LAST in the quick chain: after the contraction lookup and the home-server
// KB, so it only answers when the local KB misses or is unreachable (away from home,
// or a language/word the KB has no data for). Any miss / network error / timeout
// returns null and the chain simply yields no quick definition — unchanged behavior.
//
// The API response is large (many senses, quotes, hundreds of translations); we keep
// only what the reader/popup already consume: one definition, the part(s) of speech,
// curated synonyms/antonyms, and the IPA pronunciation. Per-target TRANSLATIONS are
// deliberately NOT requested here — that payload is hundreds of languages and heavy
// on mobile; a dedicated native-language translation is a later phase.

import { getReadingLang } from '../settings.js';

const ENDPOINT = 'https://freedictionaryapi.com/api/v1/entries/';
const TIMEOUT = 4000; // ms — public API; don't let a slow host stall a word tap

// Reading-language code → the API's language path segment. Codes already match
// except Portuguese, which the app stores region-tagged (pt-BR) while the API keys
// it under the bare macrolanguage. Anything not listed passes through unchanged.
const API_LANG = { 'pt-BR': 'pt' };

function apiLang(code) {
  return API_LANG[code] || code;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const MAX_RELATED = 12; // cap synonyms/antonyms so the popup stays compact

// Dedupe, drop the headword, cap. Mirror of kbApi.relatedList — kept local so the
// two public providers stay independent (neither imports the other).
function relatedList(words, headword) {
  const seen = new Set([headword].filter(Boolean));
  const out = [];
  for (const w of words) {
    if (typeof w !== 'string') continue;
    const t = w.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_RELATED) break;
  }
  return out;
}

// The reader's native language NAME → the language code freedictionaryapi uses in
// its translation entries. English is excluded on purpose (nothing to translate to).
const NATIVE_CODE = {
  Spanish: 'es',
  French: 'fr',
  Portuguese: 'pt',
  German: 'de',
  Italian: 'it',
};

/**
 * Translate the (English) word into the reader's native language, straight from
 * freedictionaryapi — no home server needed, so it works away from home on mobile
 * data (the metro case). freedictionaryapi's translations only exist for ENGLISH
 * source words (the data lives on the English Wiktionary), so this returns null
 * unless the book is in English and the native language is a non-English one it
 * carries. On-demand only (the payload is the word's whole entry): call it from a
 * button, never on every tap.
 * @param {string} word normalized (English) word
 * @param {string} nativeLanguageName e.g. "Spanish" (settings.getLanguage())
 * @returns {Promise<import('./index.js').Definition | null>}
 */
export async function freeDictTranslate(word, nativeLanguageName) {
  if (getReadingLang() !== 'en') return null; // translations are English-source only
  const code = NATIVE_CODE[nativeLanguageName];
  if (!code) return null;

  const url = `${ENDPOINT}en/${encodeURIComponent(word)}?translations=true`;
  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const data = await res.json();
  const words = [];
  for (const e of data?.entries || []) {
    for (const s of e.senses || []) {
      for (const t of s.translations || []) {
        if (t?.language?.code === code && typeof t.word === 'string') {
          const w = t.word.trim();
          if (w && !words.includes(w)) words.push(w);
          if (words.length >= 6) break;
        }
      }
    }
  }
  if (!words.length) return null;
  return { explanation: words.join(', '), source: 'translation' };
}

/**
 * @param {string} word normalized word
 * @returns {Promise<import('./index.js').Definition | null>}
 */
export async function lookupFreeDict(word) {
  const lang = apiLang(getReadingLang());
  const url = `${ENDPOINT}${lang}/${encodeURIComponent(word)}`;
  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch {
    return null; // timeout / offline — let the chain continue (yields no quick def)
  }
  if (!res.ok) return null; // 404 = word not found in this language

  const data = await res.json();
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  if (!entries.length) return null;

  // The shown definition: the first non-empty sense across entries (an entry per
  // part of speech). Collapse whitespace; keep the leading "(tag)" glosses — they
  // are informative context, not noise.
  let explanation = '';
  for (const e of entries) {
    for (const s of e.senses || []) {
      const d = (s.definition || '').trim().replace(/\s+/g, ' ');
      if (d) {
        explanation = d;
        break;
      }
    }
    if (explanation) break;
  }
  if (!explanation) return null;

  // Parts of speech across every entry (a word can be noun + verb); first IPA.
  const pos = [...new Set(entries.map((e) => e.partOfSpeech).filter(Boolean))];
  const pronunciation =
    entries
      .flatMap((e) => e.pronunciations || [])
      .find((p) => p?.type === 'ipa' && p.text)?.text || undefined;

  // Synonyms/antonyms aggregated across entry-level and per-sense lists.
  const syn = [];
  const ant = [];
  for (const e of entries) {
    syn.push(...(e.synonyms || []));
    ant.push(...(e.antonyms || []));
    for (const s of e.senses || []) {
      syn.push(...(s.synonyms || []));
      ant.push(...(s.antonyms || []));
    }
  }

  // No `family`/`inflections`: the raw Wiktionary `forms` mix inflections with
  // dialectal/alternative spellings, and feeding them through the KB's inflection
  // renderer would mislabel a noun plural as a verb tense — so we leave the family
  // to the curated KB and only surface what maps cleanly.
  return {
    explanation,
    source: 'freedict',
    pronunciation,
    kb: {
      pos,
      synonyms: relatedList(syn, word),
      antonyms: relatedList(ant, word),
    },
  };
}
