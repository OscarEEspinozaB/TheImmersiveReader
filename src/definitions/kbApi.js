// Local dictionary KB provider: the offline knowledge base served over the LAN by
// the Node service in server/. When configured (Settings → "Dictionary KB URL")
// and reachable, this answers from the home machine's SQLite dictionary instantly
// — no public-internet round trip.
//
// It sits in the quick chain AFTER the contraction lookup and BEFORE the public
// dictionaryapi.dev, so it's preferred when available but never blocks the reader:
// any miss / unreachable host / error returns null and the existing chain takes
// over unchanged. The returned Definition carries the richer KB fields (pos, verb
// tenses, synonyms, antonyms) for the popup/Dictionary tab, plus `refined` telling
// the reader whether to trigger a background build (see requestKbBuild).

import { getKbUrl, getReadingLang } from '../settings.js';

const TIMEOUT = 1500; // ms — the KB is local; if it's slow it's effectively absent
const LIST_TIMEOUT = 4000; // ms — listing many built words is a bit heavier than one

async function fetchWithTimeout(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const MAX_RELATED = 12; // cap synonyms/antonyms so the popup stays compact

// Dedupe, drop the word itself (and the lemma it was served from — "aim" is not a
// useful synonym of "aimed"), and cap a related-words list.
function relatedList(words, ...headwords) {
  const seen = new Set(headwords.filter(Boolean));
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

/**
 * @param {string} word normalized word
 * @returns {Promise<import('./index.js').Definition | null>}
 */
export async function lookupKB(word) {
  const base = getKbUrl();
  if (!base) return null; // feature off only if the URL is explicitly cleared

  const url = `${base}/define?word=${encodeURIComponent(word)}&lang=${encodeURIComponent(getReadingLang())}`;
  let res;
  try {
    res = await fetchWithTimeout(url, TIMEOUT);
  } catch {
    return null; // unreachable (away from home, server down) — fall through
  }
  if (!res.ok) return null; // 404 miss / 400 — let the chain continue

  const data = await res.json();
  const entry = data?.entry;
  if (!entry) return null;
  const senses = Array.isArray(entry.senses) ? entry.senses : [];
  const inflections = Array.isArray(entry.inflections) ? entry.inflections : []; // [{ tag, form }]
  const pos = Array.isArray(entry.pos) ? entry.pos : [];
  const formOf = entry.formOf || undefined; // { lemma, pos, tags } when an inflected form
  // { lemma, pos, tag, forms[] } — the paradigm this word belongs to, so the popup
  // can show the family (go · goes · went · gone) with each form in ITS own color.
  const family = entry.family || undefined;
  // The entry an inflected form was SERVED from: "aimed" carries aim's definition,
  // so aim must not then show up as one of its synonyms.
  const lemma = entry.lemma || word;

  // Prefer the AI-refined "clean" entry when this word has been built: one
  // simple-English definition plus its curated synonyms/antonyms. Verb tenses
  // always come from the raw (deterministic) Kaikki data. `refined: true` tells
  // the reader this entry is already built, so no background build is needed.
  const refined = entry.refined;
  if (refined?.definition) {
    return {
      explanation: refined.definition.trim(),
      source: 'kb',
      refined: true,
      kb: {
        pos,
        formOf,
        family,
        inflections,
        synonyms: relatedList(refined.synonyms || [], word, lemma),
        antonyms: relatedList(refined.antonyms || [], word, lemma),
      },
    };
  }

  // Otherwise fall back to the raw data: first definition + synonyms/antonyms
  // aggregated across all senses. `refined: false` — the reader will trigger a
  // background build so the next lookup serves the refined version.
  const explanation = senses[0]?.definition?.trim();
  if (!explanation) return null;
  return {
    explanation,
    source: 'kb',
    refined: false,
    kb: {
      pos,
      formOf,
      family,
      inflections,
      synonyms: relatedList(senses.flatMap((s) => s.synonyms || []), word, lemma),
      antonyms: relatedList(senses.flatMap((s) => s.antonyms || []), word, lemma),
    },
  };
}

/**
 * List the words already BUILT (AI-refined) in the KB, with basic info for a
 * browse row (word, definition, pos). Used by the Dictionary tab's "Built" filter
 * so the dictionary visibly grows as words are refined. Returns null if the KB is
 * off / unreachable (so the UI can tell "empty" from "not connected").
 * @param {{ lang?: string, q?: string, sort?: 'a-z'|'recent', limit?: number }} [opts]
 * @returns {Promise<{ word: string, definition: string, pos: string[] }[] | null>}
 */
export async function listKbWords({ lang, q = '', sort = 'a-z', limit = 5000 } = {}) {
  const base = getKbUrl();
  if (!base) return null;
  const params = new URLSearchParams({ lang: lang || getReadingLang(), q, sort, limit: String(limit) });
  let res;
  try {
    res = await fetchWithTimeout(`${base}/words?${params}`, LIST_TIMEOUT);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data?.words) ? data.words : [];
}

/**
 * The words a build asked of every public dictionary and never got an answer for —
 * proper nouns, dialect spellings, ingest artifacts. They are NOT in the dictionary
 * and never will be, so the Dictionary hub shows them as their own list rather than
 * letting them look like they vanished. Returns null if the KB is off / unreachable.
 * @param {string} [lang]
 * @returns {Promise<{ word: string, triedAt: number, tries: number }[] | null>}
 */
export async function listMissingWords(lang) {
  const base = getKbUrl();
  if (!base) return null;
  const params = new URLSearchParams({ lang: lang || getReadingLang() });
  let res;
  try {
    res = await fetchWithTimeout(`${base}/words/missing?${params}`, LIST_TIMEOUT);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data?.words) ? data.words : [];
}

/**
 * Counts about the dictionary data for the Dictionary stats card (built words,
 * with synonyms/antonyms, recent activity, base KB size). Returns null if the KB
 * is off / unreachable.
 * @param {string} [lang]
 * @returns {Promise<object | null>}
 */
export async function getKbStats(lang) {
  const base = getKbUrl();
  if (!base) return null;
  const params = new URLSearchParams({ lang: lang || getReadingLang() });
  let res;
  try {
    res = await fetchWithTimeout(`${base}/stats?${params}`, LIST_TIMEOUT);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  return res.json();
}

// Words for which a background build has already been requested this session, so
// we never fire the same slow LLM job twice.
const buildRequested = new Set();

/**
 * Read-through build: ask the KB service to refine + store this word in the
 * background. Fire-and-forget — the reader never waits on it. Resolves to true if
 * the KB now has a refined entry for the word (built just now, or already present),
 * so the caller can re-fetch and upgrade the popup; false if nothing was built
 * (Ollama unreachable, true miss, or KB off).
 * @param {string} word normalized word
 * @returns {Promise<boolean>}
 */
export async function requestKbBuild(word) {
  const base = getKbUrl();
  if (!base || !word || buildRequested.has(word)) return false;
  buildRequested.add(word);
  try {
    const res = await fetch(`${base}/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words: [word], lang: getReadingLang() }),
    });
    if (!res.ok) {
      buildRequested.delete(word); // let a later click retry
      return false;
    }
    const data = await res.json();
    const status = data?.results?.[0]?.status;
    // "seeded" = the server fetched the word from a public dictionary and stored it
    // (non-English books are seeded, never AI-refined) — the KB has it now, so the
    // reader should re-query just as it does after a refine.
    return status === 'refined' || status === 'skipped' || status === 'seeded';
  } catch {
    buildRequested.delete(word); // unreachable — allow a retry next time
    return false;
  }
}

/**
 * RE-refine a word that is already built: run the AI over it again and replace the
 * stored entry. Unlike requestKbBuild this is an explicit user action ("this
 * definition is wrong, do it over"), so it forces a rebuild and is never
 * suppressed by the once-per-session guard. The word is resolved to its lemma on
 * the server, so re-refining "aimed" re-does "aim".
 * @param {string} word normalized word
 * @returns {Promise<boolean>} true if a fresh entry was stored
 */
export async function reRefineWord(word) {
  const base = getKbUrl();
  if (!base || !word) return false;
  try {
    const res = await fetch(`${base}/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words: [word], lang: getReadingLang(), force: true }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.results?.[0]?.status === 'refined';
  } catch {
    return false;
  }
}
