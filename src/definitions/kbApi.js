// Local dictionary KB provider: the offline knowledge base served over the LAN by
// the Node service in server/. When configured (Settings → "Dictionary KB URL")
// and reachable, this answers from the home machine's SQLite dictionary instantly
// — no public-internet round trip.
//
// It sits in the quick chain AFTER the contraction lookup and BEFORE the public
// dictionaryapi.dev, so it's preferred when available but never blocks the reader:
// any miss / unreachable host / error returns null and the existing chain takes
// over unchanged. The result is the same { explanation, source } shape the rest of
// the UI already renders; the richer KB fields (inflections, synonyms, per-sense
// translations) are surfaced by the Dictionary-tab redesign, not here.

import { getKbUrl, getReadingLang } from '../settings.js';

const TIMEOUT = 1500; // ms — the KB is local; if it's slow it's effectively absent

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

// Dedupe, drop the headword itself, and cap a related-words list.
function relatedList(words, headword) {
  const seen = new Set([headword]);
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

  // Prefer the AI-refined "clean" entry when this word has been built: one
  // simple-English definition plus its curated synonyms/antonyms. Verb tenses
  // always come from the raw (deterministic) Kaikki data.
  const refined = entry.refined;
  if (refined?.definition) {
    return {
      explanation: refined.definition.trim(),
      source: 'kb',
      kb: {
        pos,
        inflections,
        synonyms: relatedList(refined.synonyms || [], word),
        antonyms: relatedList(refined.antonyms || [], word),
      },
    };
  }

  // Otherwise fall back to the raw data: first definition + synonyms/antonyms
  // aggregated across all senses.
  const explanation = senses[0]?.definition?.trim();
  if (!explanation) return null;
  return {
    explanation,
    source: 'kb',
    kb: {
      pos,
      inflections,
      synonyms: relatedList(senses.flatMap((s) => s.synonyms || []), word),
      antonyms: relatedList(senses.flatMap((s) => s.antonyms || []), word),
    },
  };
}
