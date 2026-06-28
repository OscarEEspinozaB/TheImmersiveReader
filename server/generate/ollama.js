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

// Phrase the inflection link for the prompt, e.g. "past tense / past participle".
const FORM_WORDS = {
  past: 'past tense',
  'past participle': 'past participle',
  'present participle': 'present participle',
  'third-person singular': 'third-person singular',
};

function buildPrompt({ word, pos, definitions, synonyms, antonyms, formOf }) {
  const posLine = pos.length ? `Part of speech: ${pos.join(', ')}.` : '';
  const defList = definitions.map((d, i) => `${i + 1}. ${d}`).join('\n');
  const synLine = synonyms.length ? `Known synonyms: ${synonyms.join(', ')}.` : '';
  const antLine = antonyms.length ? `Known antonyms: ${antonyms.join(', ')}.` : '';
  // The single most important fact for an inflected form — keep it in the definition.
  const formLine = formOf?.lemma
    ? `IMPORTANT: "${word}" is the ${(formOf.tags || []).map((t) => FORM_WORDS[t] || t).join(' / ')} ` +
      `of the verb "${formOf.lemma}". The definition MUST start by saying so, e.g. ` +
      `"${(FORM_WORDS[formOf.tags?.[0]] || 'form').replace(/^./, (c) => c.toUpperCase())} of '${formOf.lemma}': …".`
    : '';
  return [
    `You are writing a learner's dictionary for someone learning English.`,
    `Refine the dictionary data below for the word "${word}" into ONE clear definition.`,
    posLine,
    formLine,
    `Source definitions (may be archaic, noisy, or list several senses):`,
    defList,
    synLine,
    antLine,
    ``,
    `Rules:`,
    `- Write the definition in SIMPLE, BASIC English (short, common words).`,
    `- Choose the most common everyday meaning; ignore rare, archaic or joke senses.`,
    `- One or two short sentences, no example.`,
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
 * @param {{ word: string, pos: string[], definitions: string[], synonyms: string[], antonyms: string[], formOf?: { lemma: string, tags: string[] } }} raw
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
