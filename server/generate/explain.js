// Server-side Ollama client for CONTEXT-AWARE explanations: a word as it is used
// in a specific sentence, in simple/basic terms of the reading language, or — on
// demand — in the user's native language. This is the path the reader used to call
// directly (src/definitions/ollama.js); it now lives on the home server so the
// answer is generated once and stored for every device (see routes/aiDefine.js).
//
// Mirrors the refinement client in ./ollama.js (same fetchWithTimeout + OLLAMA_URL
// env), but the reply here is free plain text (no `format: "json"`), matching the
// prompts ported from src/definitions/prompts.js.

const OLLAMA_URL = process.env.KB_OLLAMA_URL || 'http://localhost:11434';
export const EXPLAIN_MODEL = process.env.KB_EXPLAIN_MODEL || process.env.KB_REFINE_MODEL || 'gemma4:e2b';

const TIMEOUT = 120000; // ms — CPU inference is slow; one explanation can take 10–25s
const PROBE_TIMEOUT = 1500; // ms — fast "is Ollama there?" check for /ai/health

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Matches an apostrophe in the word, signalling a contraction ("didn't", "you'd")
// or a possessive ("Dursley's"). Same heuristic as the frontend prompts.
const HAS_APOSTROPHE = /['‘’]/;

const TENSE_LABEL = {
  past: 'past simple',
  'past participle': 'past participle',
  'present participle': 'present participle',
  'third-person singular': 'third-person singular',
};
const TENSE_ORDER = ['past', 'past participle', 'present participle', 'third-person singular'];

// Render the KB's ground-truth verb paradigm (server/lemma.js → verbForms) as a
// short "label: form" list, e.g. "base: wrestle, past simple: wrestled, past
// participle: wrestled, present participle: wrestling". This is given to the model
// as REFERENCE, not to recite: if it names which form the word is, it names it
// right instead of inventing one (a small local model will otherwise say things
// like "wrestled" -> "wrestleled"). The paradigm itself is shown by the reader's
// family card (colored by learning state, and covering nouns/adjectives too, not
// only verbs), so the explanation must not repeat it.
// `paradigm` is null for any word without verb-tense data in the KB (nouns,
// adjectives, words outside the dataset) — the common case, so guard for it.
function formsLine(paradigm) {
  if (!paradigm?.lemma) return '';
  const { lemma, forms } = paradigm;
  const rest = TENSE_ORDER.filter((t) => forms[t]).map((t) => `${TENSE_LABEL[t]}: ${forms[t]}`);
  return [`base: ${lemma}`, ...rest].join(', ');
}

// Explain the word in simple terms of the reading language (ported from
// src/definitions/prompts.js → explainPrompt; `lang` is the language NAME).
// `forms` is the optional KB-grounded verb paradigm (server/lemma.js#verbForms),
// so the model doesn't have to invent it.
function explainPrompt(word, sentence, lang, forms) {
  const cliticNote = HAS_APOSTROPHE.test(word)
    ? `If "${word}" is a contraction (e.g. "didn't" = "did not", "you'd" = "you would/had") ` +
      `or a possessive (e.g. "Dursley's" = belonging to Dursley), state that first, ` +
      `then explain the base word. `
    : '';
  // The app shows the full paradigm beside the answer (the family card), so the
  // explanation must NOT list forms — that used to be half the answer, crowding out
  // the meaning and sometimes disagreeing with the card (reciting a verb paradigm
  // for a word the card shows as a noun). The grounded forms stay as private
  // reference so the one phrase naming the form is right, never invented.
  const known = formsLine(forms);
  const formNote =
    `Do NOT list the word's grammatical forms (base, past, participle, plural, …) — ` +
    `the app already shows the full set beside your answer. You may note in one short ` +
    `phrase which form "${word}" is in this sentence` +
    (known ? ` (for your reference only, its verb forms are ${known})` : '') +
    `, but keep the focus on meaning. `;
  return (
    `You are helping someone learn ${lang}. Explain the word "${word}" as it is ` +
    `used in this sentence:\n\n"${sentence}"\n\n` +
    cliticNote +
    `Start with its part of speech (noun, verb, adjective, adverb, etc.) as used HERE. ` +
    `Then, as the MAIN part of your answer, give a short, simple explanation in basic ` +
    `${lang} of what "${word}" actually MEANS in this sentence (one or two sentences). ` +
    formNote +
    `Use plain text only — no markdown, no bullet points. Be brief.`
  );
}

// Explain the word in the user's native language (ported from
// src/definitions/prompts.js → explainInLanguagePrompt). `forms` is the optional
// KB-grounded verb paradigm, same as explainPrompt.
function explainNativePrompt(word, sentence, reading, language, forms) {
  const cliticNote = HAS_APOSTROPHE.test(word)
    ? `If "${word}" is a contraction or a possessive form, explain that first. `
    : '';
  // As above: the family card shows the paradigm, so don't recite it here — spend
  // the answer on the translation, which is the part only this can give.
  const known = formsLine(forms);
  const formNote =
    `Do NOT list the word's grammatical forms — the app shows them beside your answer. ` +
    `You may note in one short phrase which form "${word}" is here` +
    (known ? ` (for your reference only, its ${reading} verb forms are ${known})` : '') +
    `. `;
  return (
    `A person learning ${reading} (native language: ${language}) needs help. ` +
    `Explain the ${reading} word "${word}" as it is used in this sentence:\n\n"${sentence}"\n\n` +
    cliticNote +
    `Answer in ${language}. The MOST IMPORTANT part of your answer is the actual ` +
    `${language} translation of "${word}" as used HERE — the real ${language} word ` +
    `or short phrase a native speaker would use to say the same thing in this ` +
    `context. Never skip it and never replace it with just a grammar description. ` +
    `Start with its part of speech, then give that ${language} translation, then a ` +
    `short, simple explanation of any nuance (one sentence). ` +
    formNote +
    `Use plain text only — no markdown, no bullet points. Be brief.`
  );
}

// Run one prompt through Ollama and return its trimmed text, or null on
// failure/timeout/empty reply (the caller leaves nothing stored).
async function generate(prompt, model) {
  let res;
  try {
    res = await fetchWithTimeout(
      `${OLLAMA_URL}/api/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false }),
      },
      TIMEOUT,
    );
  } catch {
    return null; // Ollama down / timed out
  }
  if (!res.ok) return null;
  const data = await res.json();
  const text = data?.response?.trim();
  return text || null;
}

/**
 * Context-aware explanation in the reading language.
 * @param {{ word: string, sentence: string, langName: string, forms?: { lemma: string, forms: Record<string, string> } | null, model?: string }} args
 * @returns {Promise<{ explanation: string, source: string, model: string } | null>}
 */
export async function explainInContext({ word, sentence, langName, forms, model = EXPLAIN_MODEL }) {
  const text = await generate(explainPrompt(word, sentence, langName, forms), model);
  return text ? { explanation: text, source: 'ollama', model } : null;
}

/**
 * Context-aware explanation in the user's native language.
 * @param {{ word: string, sentence: string, langName: string, nativeLanguage: string, forms?: { lemma: string, forms: Record<string, string> } | null, model?: string }} args
 * @returns {Promise<{ explanation: string, source: string, model: string } | null>}
 */
export async function explainNative({ word, sentence, langName, nativeLanguage, forms, model = EXPLAIN_MODEL }) {
  const text = await generate(explainNativePrompt(word, sentence, langName, nativeLanguage, forms), model);
  return text
    ? { explanation: text, source: `ollama · ${nativeLanguage}`, model }
    : null;
}

/** Fast reachability probe for /ai/health. */
export async function isOllamaUp() {
  try {
    const res = await fetchWithTimeout(`${OLLAMA_URL}/api/tags`, {}, PROBE_TIMEOUT);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * List locally-installed Ollama model names, for a settings picker. Empty
 * array if Ollama is unreachable.
 * @returns {Promise<string[]>}
 */
export async function listModels() {
  try {
    const res = await fetchWithTimeout(`${OLLAMA_URL}/api/tags`, {}, PROBE_TIMEOUT);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.models) ? data.models.map((m) => m.name).filter(Boolean) : [];
  } catch {
    return [];
  }
}
