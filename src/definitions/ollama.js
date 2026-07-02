// Ollama provider — used ONLY for contraction decomposition (growing the
// contraction registry), a best-effort background task with no dedicated
// settings UI: it auto-probes Ollama on the current host and silently no-ops
// when unreachable. Context-aware word explanations (reading-language and
// native-language) live on the home server instead, which brokers + caches
// them across devices, configured there via KB_OLLAMA_URL/KB_EXPLAIN_MODEL
// (see ./serverAi.js and server/routes/aiDefine.js, server/generate/explain.js).
//
// Network note: we assume Ollama runs on the same host that serves the app, so
// the URL uses the current hostname. When reading from a phone (e.g.
// http://192.168.x.x:5173), Ollama must:
//   - listen on the network:  OLLAMA_HOST=0.0.0.0 ollama serve
//   - allow the browser origin: OLLAMA_ORIGINS=* (or the specific origin)

import { decomposeContractionPrompt } from './prompts.js';

const PORT = 11434;
const MODEL = 'gemma4:e2b';

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
 * Decompose a contraction into its component words for the contraction registry.
 * Context-aware (resolves "'d" → would/had, "'s" → is/has).
 * @param {string} word the contraction surface form, e.g. "you'd"
 * @param {string} sentence
 * @returns {Promise<{ parts: string[], note?: string } | null>}
 */
export async function decompose(word, sentence) {
  if (!(await isReachable())) return null;

  const prompt = decomposeContractionPrompt(word, sentence);
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
  return parseDecomposition(data?.response);
}

// Pull the JSON object out of the model's reply (it may wrap it in prose) and
// validate it has at least two component words.
function parseDecomposition(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    const parts = Array.isArray(obj.parts)
      ? obj.parts.map((p) => String(p).trim().toLowerCase()).filter(Boolean)
      : [];
    if (parts.length < 2) return null;
    const note = typeof obj.note === 'string' && obj.note.trim() ? obj.note.trim() : undefined;
    return { parts, ...(note ? { note } : {}) };
  } catch {
    return null;
  }
}
