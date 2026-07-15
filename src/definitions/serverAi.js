// Server-brokered AI provider: the reader no longer calls Ollama directly for
// context-aware explanations. It POSTs to the home server (the same KB URL), which
// serves a stored answer when present and only calls the LLM on a miss, then stores
// it — so every device shares one generation (see server/routes/aiDefine.js).
//
// Returns a Definition ({ explanation, source }) or null when the server is
// unreachable / has no AI available (HTTP 503) — the caller then simply offers no AI
// answer, exactly as before when Ollama was unreachable. Away from home (no server)
// there is no AI, by design; the local dictionary / KB chain still works.

import { getAiModel, getKbUrl, getReadingLang, getReadingLangName } from '../settings.js';

const TIMEOUT = 120000; // ms — generation is slow on first hit; instant on a cache HIT
const HEALTH_TIMEOUT = 1500; // ms — fast "is the AI available?" probe
const HEALTH_TTL = 15000; // ms — cache the probe so we don't ping on every click

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// POST a JSON body to a server AI endpoint and return the Definition, or null.
async function post(path, body) {
  const base = getKbUrl();
  if (!base) return null; // KB/server URL not configured → no AI
  let res;
  try {
    res = await fetchWithTimeout(
      `${base}${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      TIMEOUT,
    );
  } catch {
    return null; // server unreachable (away from home, down)
  }
  if (!res.ok) return null; // 503 (Ollama down), 400, etc. — caller offers no answer
  const data = await res.json();
  return data?.explanation ? { explanation: data.explanation, source: data.source } : null;
}

/**
 * Context-aware explanation in the reading language, via the server cache.
 * @param {string} word surface form (e.g. "Dursley's", "didn't")
 * @param {string} sentence
 * @param {{ uid?: string, page?: number }} [book] active book context
 * @returns {Promise<import('./index.js').Definition | null>}
 */
export function serverAiDefine(word, sentence, book = {}, { force = false } = {}) {
  return post('/ai/define', {
    word,
    sentence,
    bookUid: book.uid || '',
    page: book.page,
    lang: getReadingLang(),
    langName: getReadingLangName(),
    model: getAiModel(),
    force, // regenerate: skip the cache and overwrite the stored answer
  });
}

/**
 * Context-aware explanation in the user's native language, via the server cache.
 * @param {string} word surface form
 * @param {string} sentence
 * @param {string} language the user's native language (e.g. "Spanish")
 * @param {{ uid?: string, page?: number }} [book] active book context
 * @param {{ force?: boolean }} [opts] force a regeneration (skip + overwrite cache)
 * @returns {Promise<import('./index.js').Definition | null>}
 */
export function serverAiExplain(word, sentence, language, book = {}, { force = false } = {}) {
  return post('/ai/explain', {
    word,
    sentence,
    nativeLanguage: language,
    bookUid: book.uid || '',
    page: book.page,
    lang: getReadingLang(),
    langName: getReadingLangName(),
    model: getAiModel(),
    force, // regenerate: skip the cache and overwrite the stored answer
  });
}

/**
 * Locally-installed Ollama model names, for the settings picker. Empty array
 * when the server/Ollama is unreachable.
 * @returns {Promise<string[]>}
 */
export async function listAiModels() {
  const base = getKbUrl();
  if (!base) return [];
  try {
    const res = await fetchWithTimeout(`${base}/ai/models`, {}, HEALTH_TIMEOUT);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.models) ? data.models : [];
  } catch {
    return [];
  }
}

// Cached health probe: is there a server AND is Ollama up behind it? Mirrors the
// old direct-Ollama probe so the UI keeps deciding when to show the "Ask AI" button.
let healthCache = { ok: false, at: 0 };

export async function serverAiAvailable() {
  const now = Date.now();
  if (now - healthCache.at < HEALTH_TTL) return healthCache.ok;
  let ok = false;
  const base = getKbUrl();
  if (base) {
    try {
      const res = await fetchWithTimeout(`${base}/ai/health`, {}, HEALTH_TIMEOUT);
      ok = res.ok && (await res.json())?.ollama === true;
    } catch {
      ok = false;
    }
  }
  healthCache = { ok, at: now };
  return ok;
}
