// On-device translation into the reader's native language (Android only).
//
// The away-from-home rescue used to be freedictionaryapi's per-sense translation
// list, but that data is Wiktionary's and its coverage collapses exactly where a
// learner needs it most: `their` returns four definitions and ZERO translations.
// ML Kit translates arbitrary TEXT instead of looking up dictionary entries, so it
// answers for every word — and for the dictionary's EXPLANATION of that word, which
// is what a learner actually needs to understand it.
//
// Why it fits this app better than any web translation API:
//   - Fully on-device. The models are downloaded once over WiFi (at home) and the
//     reader then works with no network at all — the metro case, without data.
//   - Free, no key, no quota, no request leaving the phone.
//
// Same rule as appUpdate.js: this is an optimization, NEVER a dependency. On the
// web, on a first press away from WiFi, or on any plugin error it returns null and
// the caller falls back to the freedictionaryapi path that shipped before it.

// Statically imported for the same reason appUpdate.js is: a dynamic import() puts
// the plugin in its own chunk, and a chunk that fails to load inside the WebView
// leaves the call awaiting forever. On the web this only registers a proxy, and
// `isNativeApp` gates every call.
import { Translation } from '@capacitor-mlkit/translation';
import { getReadingLang } from '../settings.js';
import { logDiag, logDiagError } from '../diagnostics.js';

/** True inside the APK; false in any browser. The whole module is Android-only. */
const isNativeApp = () => !!globalThis.Capacitor?.isNativePlatform?.();

// The reader's native language NAME (settings.LANGUAGES) → ML Kit's language code.
// ML Kit keys Portuguese under the bare macrolanguage, like the public dictionary.
const NATIVE_CODE = {
  Spanish: 'es',
  English: 'en',
  French: 'fr',
  Portuguese: 'pt',
  German: 'de',
  Italian: 'it',
};

/** Reading-language code → ML Kit's: the app stores Portuguese region-tagged. */
function readingCode(code) {
  return code === 'pt-BR' ? 'pt' : code;
}

// A first translation for a language pair downloads ~30MB per side over WiFi, so
// this budget covers a model download on a home connection; every later call is
// on-device and returns in milliseconds. Without WiFi the plugin's own
// `requireWifi()` condition fails early — it does not sit here burning the clock.
const TIMEOUT_MS = 90000;

/** Reject rather than hang: a bridge call that never settles would freeze the bubble. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('translation timed out')), ms)),
  ]);
}

/** Cap on one request: a runaway paragraph would be slow and unreadable in a bubble. */
const MAX_CHARS = 1200;

/** True when this build can translate on-device at all (used to pick the button). */
export function isMlkitAvailable() {
  return isNativeApp();
}

/** Language NAME → ML Kit code, for the model panel. Null when not translatable. */
export function modelCodeFor(languageName) {
  return NATIVE_CODE[languageName] || null;
}

/**
 * Which language models are on this device. The one question that tells a broken
 * install apart from a missing download — and the reason the model panel exists: the
 * implicit "it downloads itself on WiFi" path fails silently, and a silent failure on
 * one phone and success on another is undiagnosable without this.
 * @returns {Promise<string[] | null>} language codes, or null if unavailable
 */
export async function downloadedModels() {
  if (!isNativeApp()) return null;
  try {
    const res = await withTimeout(Translation.getDownloadedModels(), 15000);
    const codes = (res?.languages || []).filter((l) => typeof l === 'string');
    logDiag('mlkit', `models on device: ${codes.join(', ') || 'none'}`);
    return codes;
  } catch (err) {
    logDiagError('mlkit', 'getDownloadedModels failed:', err);
    return null;
  }
}

/**
 * Download one language model, on request. The plugin requires WiFi for this (its
 * own `DownloadConditions`), so on mobile data it fails — and the point of calling it
 * from a button is that the failure is now VISIBLE and its message reaches the user,
 * instead of a translation that silently answers nothing.
 * @param {string} code ML Kit language code, e.g. "es"
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function downloadModel(code) {
  if (!isNativeApp()) return { ok: false, error: 'Only available in the Android app.' };
  logDiag('mlkit', `downloading model ${code}…`);
  try {
    await withTimeout(Translation.downloadModel({ language: code }), TIMEOUT_MS);
    logDiag('mlkit', `model ${code} downloaded`);
    return { ok: true };
  } catch (err) {
    logDiagError('mlkit', `model ${code} download failed:`, err);
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Translate arbitrary text from the book's language into the reader's own.
 *
 * Deliberately generic: this module is not a dictionary, it is a translator, and its
 * callers decide WHAT deserves translating. That choice is pedagogical, not
 * technical — see `translateToNative` (a word and the dictionary's explanation of
 * it) and `translateFragment` (a passage, only when the reader asks to check their
 * comprehension) in ./index.js.
 *
 * @param {string} text
 * @param {string} nativeLanguageName e.g. "Spanish" (settings.getLanguage())
 * @returns {Promise<string | null>} null = unavailable; the caller decides the fallback
 */
export async function translateText(text, nativeLanguageName) {
  if (!isNativeApp()) {
    logDiag('mlkit', 'skipped: not a native app');
    return null;
  }
  const clean = (text || '').trim().replace(/\s+/g, ' ');
  if (!clean) return null;

  const target = NATIVE_CODE[nativeLanguageName];
  const source = readingCode(getReadingLang());
  // Reading in your own language: there is nothing to translate (and the red sea is
  // suppressed there anyway, so this button should not have been offered).
  if (!target || !source || target === source) {
    logDiag('mlkit', `skipped: source=${source} target=${target} (${nativeLanguageName})`);
    return null;
  }
  logDiag('mlkit', `translate ${clean.length} chars ${source}→${target}`);

  try {
    const res = await withTimeout(
      Translation.translate({
        text: clean.slice(0, MAX_CHARS),
        sourceLanguage: source,
        targetLanguage: target,
      }),
      TIMEOUT_MS,
    );
    const out = (res?.text || '').trim();
    if (!out) {
      logDiagError('mlkit', 'empty translation — raw:', res);
      return null;
    }
    // The on-device models are small, and out-of-domain input (dictionary
    // metalanguage like "first-person singular simple past indicative of be") comes
    // back COPIED rather than translated. Returning that would print an English line
    // under a Spanish heading and call it a translation — worse than admitting there
    // is none, and invisible without this check.
    if (out.toLowerCase() === clean.toLowerCase()) {
      logDiag('mlkit', `no-op translation (model returned the input): "${clean.slice(0, 60)}"`);
      return null;
    }
    return out;
  } catch (err) {
    // The reason matters and there is no console on the phone to print it to: this
    // is the line that tells "model not downloaded" apart from "plugin missing".
    logDiagError('mlkit', 'failed:', err);
    return null; // no model yet and no WiFi, or the plugin is missing
  }
}
