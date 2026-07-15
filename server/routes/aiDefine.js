// Context-aware AI explanations, brokered + cached by the server so they are
// generated once and shared across every device on the LAN.
//
//   POST /ai/define   -> explain a word in its sentence (reading language)
//   POST /ai/explain  -> explain a word in its sentence (user's native language)
//   GET  /ai/health   -> { ollama: boolean } so the reader can offer/hide the button
//
// The reader used to call Ollama directly (src/definitions/ollama.js); now it asks
// here. On a cache HIT we serve the stored answer without touching the LLM. On a
// MISS we call Ollama once, store the result, and return it. The sentence is the
// stable cross-device identity (the visual page is not), so the cache key hashes
// book + lang + kind + native language + word + sentence.

import { Router } from 'express';
import { createHash } from 'node:crypto';
import { normalize } from '../../src/normalize.js';
import { getLibraryDb } from '../library-db.js';
import { getDb } from '../db.js';
import { verbForms } from '../lemma.js';
import { explainInContext, explainNative, isOllamaUp, listModels } from '../generate/explain.js';
import { kbLog, KB_COLORS as C } from '../log.js';

export const aiDefineRouter = Router();

// Bump when the prompt wording changes meaningfully, so previously-cached (now
// stale/weaker) answers stop being served and get regenerated instead of hiding
// the improvement behind the cache forever.
// v3: the explanation no longer recites the grammatical paradigm (the family card
// shows it); the answer is meaning/translation only.
const PROMPT_VERSION = 3;

// The model is part of the cache identity: switching models in settings should
// get a fresh answer from that model, not silently reuse another model's cached
// one. '' (server default) keeps existing cache entries valid.
function keyOf({ bookUid, lang, kind, nativeLang, word, sentence, model }) {
  return createHash('sha256')
    .update([PROMPT_VERSION, bookUid, lang, kind, nativeLang, word, sentence, model || ''].join('|'))
    .digest('hex');
}

// In-flight generations, keyed by cache key, so two devices asking for the same
// word+sentence at once trigger a single LLM call (the second awaits the first).
const inflight = new Map();

/**
 * Shared handler for both kinds. `kind` is 'explain' (reading language) or
 * 'native' (user's language). `generate` runs the LLM on a miss.
 */
async function handle(req, res, { kind, nativeLang, generate }) {
  const b = req.body || {};
  const lang = String(b.lang || 'en');
  const langName = String(b.langName || lang);
  const sentence = String(b.sentence || '').trim();
  const surface = String(b.word || '').trim();
  const word = normalize(surface);
  const bookUid = String(b.bookUid || '');
  const page = Number.isFinite(Number(b.page)) ? Number(b.page) : null;
  // Optional per-request model override (from the settings picker); '' = server default.
  const model = String(b.model || '').trim();
  if (!word || !sentence) return res.status(400).json({ error: 'word and sentence required' });

  const db = getLibraryDb();
  const key = keyOf({ bookUid, lang, kind, nativeLang, word, sentence, model });

  // Compact fingerprint of the exact cache inputs, so two consults of the "same"
  // point can be compared in the log: a matching #key that still MISSes means a
  // store/read bug; a differing #key means the client sent different inputs.
  const fp = `${word} #${key.slice(0, 8)} [book=${bookUid || '∅'} lang=${lang} nat=${nativeLang || '∅'} slen=${sentence.length} model=${model || '∅'}]`;

  const hit = db
    .prepare('SELECT explanation, source, model FROM ai_definitions WHERE key = ?')
    .get(key);
  if (hit) {
    kbLog(C.green, 'HIT·ai', fp, hit.explanation);
    return res.json({ explanation: hit.explanation, source: hit.source, model: hit.model, cached: true });
  }

  kbLog(C.yellow, 'MISS·ai', fp, sentence);
  try {
    // Ground the prompt with the KB's real verb paradigm, if any, as REFERENCE:
    // the explanation names which form the word is (right, not invented) but does
    // not recite the paradigm — the reader's family card shows that.
    let forms = null;
    try {
      forms = verbForms(getDb(), lang, word);
    } catch (err) {
      console.warn('verbForms lookup failed:', err);
    }

    // Coalesce concurrent identical requests onto one generation.
    let pending = inflight.get(key);
    if (!pending) {
      pending = generate({ word: surface, sentence, langName, nativeLanguage: nativeLang, forms, model: model || undefined });
      inflight.set(key, pending);
    }
    const result = await pending.finally(() => inflight.delete(key));
    if (!result) return res.status(503).json({ error: 'ai unavailable' });

    db.prepare(
      `INSERT OR IGNORE INTO ai_definitions
         (key, book_uid, lang, word, surface, sentence, kind, native_lang, explanation, source, model, page, created_at)
       VALUES (@key, @bookUid, @lang, @word, @surface, @sentence, @kind, @nativeLang, @explanation, @source, @model, @page, @createdAt)`,
    ).run({
      key,
      bookUid,
      lang,
      word,
      surface,
      sentence,
      kind,
      nativeLang,
      explanation: result.explanation,
      source: result.source,
      model: result.model || null,
      page,
      createdAt: Date.now(),
    });
    kbLog(C.blue, 'STORED·ai', fp, result.explanation);
    return res.json({ explanation: result.explanation, source: result.source, model: result.model, cached: false });
  } catch (err) {
    console.error('ai define failed:', err);
    return res.status(503).json({ error: 'ai unavailable' });
  }
}

aiDefineRouter.post('/ai/define', (req, res) =>
  handle(req, res, {
    kind: 'explain',
    nativeLang: '',
    generate: ({ word, sentence, langName, forms, model }) => explainInContext({ word, sentence, langName, forms, model }),
  }),
);

aiDefineRouter.post('/ai/explain', (req, res) => {
  const nativeLanguage = String(req.body?.nativeLanguage || '').trim();
  if (!nativeLanguage) return res.status(400).json({ error: 'nativeLanguage required' });
  return handle(req, res, {
    kind: 'native',
    nativeLang: nativeLanguage,
    generate: ({ word, sentence, langName, nativeLanguage, forms, model }) =>
      explainNative({ word, sentence, langName, nativeLanguage, forms, model }),
  });
});

aiDefineRouter.get('/ai/health', async (_req, res) => {
  res.json({ ollama: await isOllamaUp() });
});

// Locally-installed Ollama models, for the settings picker.
aiDefineRouter.get('/ai/models', async (_req, res) => {
  res.json({ models: await listModels() });
});
