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
  const explanation = data?.entry?.senses?.[0]?.definition?.trim();
  return explanation ? { explanation, source: 'kb' } : null;
}
