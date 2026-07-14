// Server-side Ollama client for REFINING a raw Kaikki entry into one clean,
// simple-English definition plus a short curated synonym/antonym list.
//
// This is the generic-dictionary refinement of the design (§0.4/§0.5): the LLM is
// not inventing meaning from nothing — it is condensing the offline data the KB
// already holds into the "simple / basic English" the reader needs, picking the
// everyday sense and dropping Wiktextract noise ("Alternative letter-case form of
// …", archaic glosses). Context-aware, book-specific explanation stays the reader's
// on-demand path; this is the cacheable standard meaning.
//
// Uses Ollama's `format: "json"` so the reply is always parseable JSON, no prose.

const OLLAMA_URL = process.env.KB_OLLAMA_URL || 'http://localhost:11434';
export const REFINE_MODEL = process.env.KB_REFINE_MODEL || 'gemma4:e2b';

// The CONTRACT a stored `refined` row was written under. Bump it whenever the
// prompt or the shape of a good entry changes, and `npm run kb:audit --fix`
// re-generates every row written under an older one. Without it there is no way to
// tell a fine entry from one produced by rules we have since abandoned.
//
//   rev 1 — one definition + synonyms/antonyms, refined PER SURFACE FORM, and an
//           inflected form's definition had to open with "Past tense of 'x': …".
//   rev 2 — refined per LEMMA only (forms serve their lemma's entry, and the UI
//           states the link in the family card's banner, so the definition is free
//           to just define the word).
export const REFINE_REV = 2;

const TIMEOUT = 120000; // ms — CPU inference is slow; one word can take 10–25s

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// The word handed to this prompt is always a LEMMA (build.js resolves forms first),
// so it never has to describe an inflection — the reader's family card names the
// link ("Past tense of aim · verb") right above the definition. The prompt's one
// job is to define the word well.
function buildPrompt({ word, pos, definitions, synonyms, antonyms }) {
  const posLine = pos.length ? `Part of speech: ${pos.join(', ')}.` : '';
  const defList = definitions.map((d, i) => `${i + 1}. ${d}`).join('\n');
  const synLine = synonyms.length ? `Known synonyms: ${synonyms.join(', ')}.` : '';
  const antLine = antonyms.length ? `Known antonyms: ${antonyms.join(', ')}.` : '';
  return [
    `You are writing a learner's dictionary for someone learning English.`,
    `Refine the dictionary data below for the word "${word}" into ONE clear definition.`,
    posLine,
    `Source definitions (may be archaic, noisy, or list several senses):`,
    defList,
    synLine,
    antLine,
    ``,
    `Rules:`,
    `- Write the definition in SIMPLE, BASIC English (short, common words).`,
    `- Choose the most common everyday meaning; ignore rare, archaic or joke senses.`,
    `- One or two short sentences, no example.`,
    `- Define the word itself. Do NOT write "form of", "plural of" or "past tense of" —`,
    `  the app shows the grammar separately; a definition that only points at another`,
    `  word teaches nothing.`,
    `- synonyms/antonyms: at most 6 each, common single words only, [] if none fit.`,
    ``,
    `Reply with ONLY a JSON object of this exact shape:`,
    `{"definition": "string", "synonyms": ["string"], "antonyms": ["string"]}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    const t = String(v || '').trim();
    if (t && !/\s/.test(t) && !out.includes(t)) out.push(t);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Refine one entry's raw data into a clean simple-English definition.
 * @param {{ word: string, pos: string[], definitions: string[], synonyms: string[], antonyms: string[] }} raw a LEMMA's raw data
 * @param {string} [model] Ollama model to use (default REFINE_MODEL)
 * @returns {Promise<{ definition: string, synonyms: string[], antonyms: string[] } | null>}
 */
export async function refineEntry(raw, model = REFINE_MODEL) {
  const prompt = buildPrompt(raw);
  let res;
  try {
    res = await fetchWithTimeout(
      `${OLLAMA_URL}/api/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false, format: 'json' }),
      },
      TIMEOUT,
    );
  } catch {
    return null; // Ollama down / timed out — caller leaves the raw entry untouched
  }
  if (!res.ok) return null;

  const data = await res.json();
  let obj;
  try {
    obj = JSON.parse(data?.response || '');
  } catch {
    return null;
  }
  const definition = String(obj?.definition || '').trim();
  if (!definition) return null;
  return {
    definition,
    synonyms: cleanList(obj.synonyms),
    antonyms: cleanList(obj.antonyms),
  };
}
