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

// Grammatical vocabulary that marks a Wiktionary "form of" gloss. A definition that
// carries one of these AND an "of X" is not a meaning at all — it is a pointer to the
// lemma that holds the meaning ("was" → *first-person singular simple past indicative
// of be*). Recognising that from the prose alone is what lets an OFFLINE reader
// follow the pointer, with no KB to ask.
const FORM_OF_WORDS =
  /\b(form|forms|plural|singular|past|participle|present|future|preterite|comparative|superlative|gerund|infinitive|indicative|subjunctive|imperative|conditional|inflection|genitive|dative|accusative|nominative|vocative|person|tense|feminine|masculine|neuter)\b/i;

/**
 * The lemma a "form of" definition points at, or null when the text is a real
 * meaning. Text-only, so it works on any provider's prose (and offline).
 * @param {string} definition e.g. "first-person singular simple past indicative of be."
 * @returns {string | null} e.g. "be"
 */
export function lemmaFromFormOf(definition) {
  const text = (definition || '').trim();
  if (!text || !FORM_OF_WORDS.test(text)) return null;
  // Greedy prefix → the LAST "of X" ("genitive singular of X"), letters only.
  const m = /^.*\bof\s+([\p{L}\p{M}'-]+)/u.exec(text);
  return m ? m[1] : null;
}

// The English Wiktionary stores meaning — and therefore translations — on the LEMMA
// only: an inflected form is a "form of" stub ("grunted" → *simple past and past
// participle of grunt*) whose senses carry an empty translation list. Follow that
// pointer out of the definition text so a tapped inflection still gets an answer.
// Same rule as the KB's lemma layer, done offline from the API's own prose because
// away from home there is no KB to ask.
function formOfLemma(data) {
  for (const e of data?.entries || []) {
    for (const s of e.senses || []) {
      if (!(s.tags || []).includes('form of')) continue;
      // Greedy prefix → the LAST "of X" ("genitive singular of X"), letters only.
      const m = /^.*\bof\s+([\p{L}\p{M}'-]+)/u.exec(s.definition || '');
      if (m) return m[1];
    }
  }
  return null;
}

// Fetch one English entry with its translations. Returns the parsed body, or null
// on timeout / offline / 404 — the caller decides what a miss means.
async function fetchEntry(word) {
  const url = `${ENDPOINT}en/${encodeURIComponent(word)}?translations=true`;
  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  return res.json();
}

const MAX_TRANSLATIONS = 6; // the popup shows a short list, not a thesaurus

function translationsFor(data, code) {
  const words = [];
  for (const e of data?.entries || []) {
    for (const s of e.senses || []) {
      for (const t of s.translations || []) {
        if (t?.language?.code !== code || typeof t.word !== 'string') continue;
        const w = t.word.trim();
        if (w && !words.includes(w)) words.push(w);
        if (words.length >= MAX_TRANSLATIONS) return words;
      }
    }
  }
  return words;
}

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

  const data = await fetchEntry(word);
  if (!data) return null;

  let words = translationsFor(data, code);
  let lemma = null;
  if (!words.length) {
    // One hop only: the lemma's entry is a real one, it never points further.
    lemma = formOfLemma(data);
    if (!lemma || lemma === word) return null;
    const lemmaData = await fetchEntry(lemma);
    if (!lemmaData) return null;
    words = translationsFor(lemmaData, code);
    if (!words.length) return null;
  }

  // Name the lemma when the answer came from it: the tapped word is not the word
  // being translated, and hiding that would misattribute the meaning.
  const explanation = lemma ? `${words.join(', ')} (${lemma})` : words.join(', ');
  return { explanation, source: 'translation' };
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
