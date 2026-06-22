// Ollama provider: a local LLM gives a context-aware explanation in simple,
// basic English. The word AND its full sentence are sent so the meaning matches
// how the word is actually used.
//
// Network note: we assume Ollama runs on the same host that serves the app, so
// the URL uses the current hostname. When reading from a phone (e.g.
// http://192.168.x.x:5173), Ollama must:
//   - listen on the network:  OLLAMA_HOST=0.0.0.0 ollama serve
//   - allow the browser origin: OLLAMA_ORIGINS=* (or the specific origin)

import { explainPrompt, explainInLanguagePrompt } from './prompts.js';

const PORT = 11434;
// Must be a model you have pulled (see `ollama list`). gemma3:4b is small + fast.
const MODEL = 'gemma3:4b';

const REACH_TIMEOUT = 1500; // ms — fast "is Ollama there?" probe
const REACH_TTL = 15000; // ms — cache the probe result to avoid pinging every click
const GENERATE_TIMEOUT = 60000; // ms — generation may be slow on first load

function ollamaBaseUrl() {
  return `http://${window.location.hostname}:${PORT}`;
}

// fetch with an AbortController timeout.
async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Cached reachability probe so that, away from home, we fall back to the
// dictionary almost instantly instead of hanging on an unreachable host.
let reachCache = { ok: false, at: 0 };

export async function isReachable() {
  const now = Date.now();
  if (now - reachCache.at < REACH_TTL) return reachCache.ok;
  let ok = false;
  try {
    const res = await fetchWithTimeout(`${ollamaBaseUrl()}/api/tags`, {}, REACH_TIMEOUT);
    ok = res.ok;
  } catch {
    ok = false;
  }
  reachCache = { ok, at: now };
  return ok;
}

/**
 * @param {string} word normalized word
 * @param {string} sentence the sentence the word appears in
 * @returns {Promise<import('./index.js').Definition | null>}
 */
export async function lookupOllama(word, sentence) {
  // Skip fast if Ollama is not reachable (e.g. away from home) so the chain
  // falls through to the dictionary without a long wait.
  if (!(await isReachable())) return null;

  const prompt = explainPrompt(word, sentence);

  const res = await fetchWithTimeout(
    `${ollamaBaseUrl()}/api/generate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt, stream: false }),
    },
    GENERATE_TIMEOUT,
  );
  if (!res.ok) return null;
  const data = await res.json();
  const explanation = data?.response?.trim();
  return explanation ? { explanation, source: 'ollama' } : null;
}

/**
 * On-demand rescue: explain the word in the user's native language. The reading
 * material stays English; this is only used when the user explicitly asks for it.
 * @param {string} word normalized word
 * @param {string} sentence the sentence the word appears in
 * @param {string} language the user's native language (e.g. "Spanish")
 * @returns {Promise<import('./index.js').Definition | null>}
 */
export async function explainInLanguage(word, sentence, language) {
  if (!(await isReachable())) return null;

  const prompt = explainInLanguagePrompt(word, sentence, language);

  const res = await fetchWithTimeout(
    `${ollamaBaseUrl()}/api/generate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt, stream: false }),
    },
    GENERATE_TIMEOUT,
  );
  if (!res.ok) return null;
  const data = await res.json();
  const explanation = data?.response?.trim();
  return explanation ? { explanation, source: `ollama · ${language}` } : null;
}
