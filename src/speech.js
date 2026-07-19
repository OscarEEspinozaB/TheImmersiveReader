// Speech with the browser's built-in voices (Web Speech API) — free,
// offline-capable, no server involved. Speaks single words (gloss bubble,
// Dictionary hub) and paragraph tails (paragraph bubble's "Read from here").
// Callers can follow along via `onBoundary` (character offset of the word being
// spoken — Web Speech boundary events on the web, the native engine's
// onRangeStart on Android); engines without boundary events simply never call
// it. Voice and speed are user settings (Settings → Voice / Voice speed).
// Continuous book-length reading lives in readAloud.js, which chains paragraph
// speaks on top of this module.
//
// Two engine quirks are worked around here:
//  • cancel() immediately followed by speak() clips the first words on several
//    engines (Chrome/Linux especially) — when something was playing, the new
//    speech starts after a short settle delay.
//  • Long single utterances can stall/clip; text is chunked into sentences and
//    queued, which also keeps cancellation responsive.

import { getReadingLang, getTtsRate, getTtsVoice } from './settings.js';
import { TextToSpeech } from '@capacitor-community/text-to-speech';

// On Android/iOS the app runs inside a Capacitor WebView whose engine has NO
// Web Speech API (window.speechSynthesis is absent), so every 🔊 button and the
// voice settings would silently vanish. When running natively we route speech
// through the platform's own TTS engine via @capacitor-community/text-to-speech
// instead; on the web the original Web Speech path below is untouched.
const NATIVE = !!globalThis.Capacitor?.isNativePlatform?.();

/** Whether speech is available at all (native engine, or Web Speech on the web). */
export function canSpeak() {
  if (NATIVE) return true;
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// --- Native (Capacitor) backend -------------------------------------------------
// The plugin is Promise-based (one call speaks, resolves when finished) and has
// no per-utterance events, so the shared "active/token/pill" machinery below is
// enough to drive the now-playing pill and the always-fires onEnd contract.
let nativeVoices = []; // cached { voiceURI, name, lang }[] from the OS engine
if (NATIVE) {
  // Guard against a synchronous throw too — this runs at module load, so an
  // uncaught error here would abort every importer (including main.js startup).
  try {
    TextToSpeech.getSupportedVoices()
      .then((r) => {
        nativeVoices = r?.voices || [];
      })
      .catch(() => {
        nativeVoices = [];
      });
    // One listener for the app's lifetime: the native engine reports the char
    // range of each word as it is spoken; route it to the active speech's
    // onBoundary (activeOnBoundary is cleared whenever a speech run ends).
    TextToSpeech.addListener('onRangeStart', (info) => {
      activeOnBoundary?.(info.start);
    }).catch(() => {});
  } catch (err) {
    console.error('getSupportedVoices failed:', err);
  }
}

// The plugin's speak() takes a voice as an INDEX into getSupportedVoices(); map
// our saved voiceURI (or the first voice for the language) to that index.
function nativeVoiceIndex(lang) {
  if (!nativeVoices.length) return null;
  const base = (lang || 'en').toLowerCase();
  const saved = getTtsVoice();
  if (saved) {
    const i = nativeVoices.findIndex(
      (v) => v.voiceURI === saved && (v.lang || '').toLowerCase().startsWith(base),
    );
    if (i >= 0) return i;
  }
  const i = nativeVoices.findIndex((v) => (v.lang || '').toLowerCase().startsWith(base));
  return i >= 0 ? i : null;
}

function speakNative(text, lang, { rate, onEnd, onBoundary }) {
  invalidate(); // stop-logical whatever was playing; fires its onEnd
  const token = speakToken; // current after invalidate() bumped it
  activeOnEnd = onEnd || null;
  activeOnBoundary = onBoundary || null;
  active = true;
  schedulePill(token);
  const finish = (completed) => {
    if (token !== speakToken) return;
    active = false;
    activeOnBoundary = null;
    if (completed) hidePillSoon(); // linger: a chained follow-up may be coming
    else hidePill();
    const cb = activeOnEnd;
    activeOnEnd = null;
    cb?.(completed);
  };
  TextToSpeech.stop()
    .catch(() => {})
    .then(() => {
      if (token !== speakToken) return undefined; // replaced/stopped meanwhile
      const opts = { text, lang: lang || 'en', rate: rate ?? getTtsRate() };
      const vi = nativeVoiceIndex(lang);
      if (vi != null) opts.voice = vi;
      return TextToSpeech.speak(opts);
    })
    .then(() => finish(true))
    .catch(() => finish(false));
  return true;
}

const CANCEL_SETTLE_MS = 120; // beat between cancel() and the next speak()

// --- Voices ---------------------------------------------------------------------
// getVoices() is empty until the engine has loaded them (async on Chrome), so
// cache the list and keep it fresh via voiceschanged. Touching getVoices() at
// module load also warms the engine, which helps against first-utterance clipping.
let voices = [];
function refreshVoices() {
  voices = window.speechSynthesis?.getVoices() || [];
}
// Web Speech only. canSpeak() is also true on native (where speech goes through
// the plugin), but window.speechSynthesis is ABSENT there — touching it would
// throw at module load and abort every importer (this is what blanked the app).
if (!NATIVE && 'speechSynthesis' in window) {
  refreshVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
}

/** Installed voices, freshest available list. */
export function listVoices() {
  if (NATIVE) return nativeVoices;
  if (canSpeak() && !voices.length) refreshVoices();
  return voices;
}

// The voice to speak `lang` with: the user's saved choice if it exists and fits
// the language, else the first installed voice for the language, else none (the
// engine default, guided by utterance.lang).
function resolveVoice(lang) {
  const all = listVoices();
  const base = (lang || 'en').toLowerCase();
  const saved = getTtsVoice();
  if (saved) {
    const v = all.find((x) => x.voiceURI === saved);
    if (v && (v.lang || '').toLowerCase().startsWith(base)) return v;
  }
  return all.find((v) => (v.lang || '').toLowerCase().startsWith(base)) || null;
}

// Sentence chunks for queueing (one utterance per sentence). Each chunk keeps
// its `start` offset into the original text so per-utterance boundary events
// (relative to the chunk) can be mapped back to offsets the caller understands.
function chunksOf(text, lang) {
  try {
    const out = [];
    for (const s of new Intl.Segmenter(lang, { granularity: 'sentence' }).segment(text)) {
      const t = s.segment.trim();
      if (t) out.push({ text: t, start: s.index + s.segment.indexOf(t) });
    }
    return out.length ? out : [{ text, start: 0 }];
  } catch {
    return [{ text, start: 0 }];
  }
}

// --- "Now playing" pill ----------------------------------------------------------
// The stop control lives in transient UI (the bubble auto-hides), so while
// speech is active a small fixed pill shows at the bottom: it both signals that
// something is playing and stops it on tap. It appears only for speech that
// lasts past a beat, so a quick word pronunciation doesn't flash UI.
const PILL_DELAY_MS = 300;
// How long the pill outlives a NATURALLY finished speech: continuous read-aloud
// (readAloud.js) chains paragraph after paragraph with a breathing gap between
// them, and the pill must not blink out and back at every paragraph seam. Must
// exceed that gap (plus the engines' settle delay). An explicit stop still
// hides it at once.
const PILL_LINGER_MS = 1000;
let pill = null;
let pillTimer = null;
let pillHideTimer = null;

function ensurePill() {
  if (pill) return;
  pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'playback-pill';
  pill.hidden = true;
  pill.textContent = '⏹ Stop reading';
  pill.setAttribute('aria-label', 'Stop reading aloud');
  pill.addEventListener('click', () => stopSpeaking());
  document.body.appendChild(pill);
}

function schedulePill(token) {
  if (pillTimer) clearTimeout(pillTimer);
  if (pillHideTimer) {
    clearTimeout(pillHideTimer); // a new speech keeps a lingering pill alive
    pillHideTimer = null;
  }
  pillTimer = setTimeout(() => {
    pillTimer = null;
    if (token !== speakToken || !active) return;
    ensurePill();
    pill.hidden = false;
  }, PILL_DELAY_MS);
}

function hidePill() {
  if (pillTimer) {
    clearTimeout(pillTimer);
    pillTimer = null;
  }
  if (pillHideTimer) {
    clearTimeout(pillHideTimer);
    pillHideTimer = null;
  }
  if (pill) pill.hidden = true;
}

// Hide the pill only if nothing new starts playing within the linger window.
function hidePillSoon() {
  if (pillHideTimer) clearTimeout(pillHideTimer);
  pillHideTimer = setTimeout(() => {
    pillHideTimer = null;
    if (!active) hidePill();
  }, PILL_LINGER_MS);
}

// --- Speaking -------------------------------------------------------------------
let speakToken = 0; // invalidates the in-flight speech's handlers
let activeOnEnd = null;
let activeOnBoundary = null;
let active = false;
let lastCancelAt = 0;
// HARD references to every queued utterance: Chrome garbage-collects utterance
// objects that JS no longer references — even queued/playing ones — which mutes
// them and never fires their events. Cleared only when a speech run ends.
let liveUtterances = [];

// End the current speech logically: whoever was playing gets its onEnd (so play
// buttons always restore), and stale utterance events become no-ops. This is
// the cancelled path — onEnd fires with completed=false.
function invalidate() {
  speakToken += 1;
  const wasActive = active;
  active = false;
  activeOnBoundary = null;
  liveUtterances = [];
  // Only a real interruption hides the pill. When nothing was playing (a new
  // paragraph starting inside the chain's gap), a lingering pill must survive
  // the seam — schedulePill() then adopts it for the new speech.
  if (wasActive) hidePill();
  const cb = activeOnEnd;
  activeOnEnd = null;
  cb?.(false);
}

function cancelEngine() {
  window.speechSynthesis.cancel();
  lastCancelAt = Date.now();
}

/**
 * Speak `text`, cancelling anything already playing — speaking several things in
 * a row should always voice the LAST one, not queue a backlog.
 * @param {string} text
 * @param {string} lang BCP-47 reading-language code (e.g. "en", "es", "pt-BR")
 * @param {{ rate?: number, onEnd?: (completed: boolean) => void,
 *           onBoundary?: (offset: number) => void }} [opts]
 *   `onEnd` always fires — with `completed=true` on natural end, `false` when
 *   the speech was cancelled/replaced — so callers can rely on it to restore a
 *   play button, and chained readers (readAloud.js) can tell "go on" from
 *   "stop". `onBoundary` fires with the character offset (into `text`) of each
 *   word as it starts being spoken — best-effort: engines without boundary
 *   events never call it.
 * @returns {boolean} whether speech started
 */
export function speak(text, lang, { rate = getTtsRate(), onEnd, onBoundary } = {}) {
  if (!canSpeak() || !text) return false;
  if (NATIVE) return speakNative(text, lang, { rate, onEnd, onBoundary });
  const synth = window.speechSynthesis;
  invalidate();
  // Only poke the engine when something is actually playing/queued: cancelling
  // an idle engine is what needs the settle delay afterwards, so an idle-start
  // stays instant.
  if (synth.speaking || synth.pending) cancelEngine();

  const token = speakToken;
  activeOnEnd = onEnd || null;
  active = true;
  schedulePill(token); // "now playing" indicator + always-reachable stop

  const chunks = chunksOf(text, lang || 'en');
  const voice = resolveVoice(lang);
  const start = () => {
    if (token !== speakToken) return; // replaced/stopped during the settle delay
    let remaining = chunks.length;
    for (const chunk of chunks) {
      const u = new SpeechSynthesisUtterance(chunk.text);
      u.lang = lang || 'en';
      if (voice) u.voice = voice;
      u.rate = rate;
      if (onBoundary) {
        u.onboundary = (e) => {
          if (token !== speakToken) return;
          if (e.name && e.name !== 'word') return; // sentence boundaries etc.
          onBoundary(chunk.start + (e.charIndex || 0));
        };
      }
      let done = false; // some engines fire BOTH end and error for one utterance
      u.onend = u.onerror = () => {
        if (done || token !== speakToken) return;
        done = true;
        remaining -= 1;
        if (remaining === 0) {
          active = false;
          activeOnBoundary = null;
          liveUtterances = [];
          hidePillSoon(); // natural end — linger for a chained follow-up
          const cb = activeOnEnd;
          activeOnEnd = null;
          cb?.(true);
        }
      };
      liveUtterances.push(u); // keep it alive (see note above)
      synth.speak(u);
    }
  };
  // speak() too soon after ANY cancel() clips or silently drops the opening
  // words on several engines — give it a beat whenever a cancel just happened.
  if (Date.now() - lastCancelAt < CANCEL_SETTLE_MS) setTimeout(start, CANCEL_SETTLE_MS);
  else start();
  return true;
}

// Stop-request subscribers: the continuous reader (readAloud.js) must also end
// its session when the pill's ⏹ is tapped BETWEEN paragraphs — at that moment
// no speech is active, so its onEnd(false) alone can't carry the news.
const stopListeners = new Set();

/** Subscribe to every explicit stop request (the pill, any stopSpeaking call). */
export function onSpeechStop(fn) {
  stopListeners.add(fn);
}

/** Stop whatever is being spoken (no-op when silent). Fires its onEnd. */
export function stopSpeaking() {
  invalidate();
  hidePill(); // even a lingering pill: an explicit stop leaves no trace
  for (const fn of stopListeners) fn();
  if (NATIVE) {
    TextToSpeech.stop().catch(() => {});
    return;
  }
  if (canSpeak()) cancelEngine();
}

/** Whether something is being spoken right now. */
export function isSpeaking() {
  return active;
}

/** Pronounce one word. */
export function speakWord(text, lang) {
  speak(text, lang);
}

/**
 * A small 🔊 button that pronounces `text` on click. Returns null when the
 * browser has no speech synthesis, so callers can just skip appending it.
 * Clicks never propagate — the button lives inside clickable rows/bubbles.
 * @param {string} text
 * @param {() => string} getLang resolved at click time (the active language can
 *   change under a long-lived row)
 * @returns {HTMLButtonElement | null}
 */
export function speakerButton(text, getLang) {
  if (!canSpeak()) return null;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'speak-btn';
  btn.title = `Pronounce “${text}”`;
  btn.setAttribute('aria-label', `Pronounce ${text}`);
  btn.textContent = '🔊';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    speakWord(text, getLang());
  });
  return btn;
}

/**
 * Voices suitable for a reading language (prefix match on the BCP-47 code),
 * for the Settings picker. Falls back to ALL voices when none match, so the
 * picker is never inexplicably empty.
 * @param {string} [lang] defaults to the active reading language
 * @returns {SpeechSynthesisVoice[]}
 */
export function voicesForLang(lang = getReadingLang()) {
  const all = listVoices();
  const base = (lang || 'en').toLowerCase();
  const match = all.filter((v) => (v.lang || '').toLowerCase().startsWith(base));
  return match.length ? match : all;
}

// English display names for locale tags ("en-GB" → "English — United Kingdom").
// Guarded: Intl.DisplayNames may be missing or reject odd tags.
function localeLabel(tag) {
  try {
    const [base, region] = tag.split('-');
    const l = new Intl.DisplayNames(['en'], { type: 'language' }).of(base);
    const r = region ? new Intl.DisplayNames(['en'], { type: 'region' }).of(region.toUpperCase()) : '';
    return r ? `${l} — ${r}` : l || tag;
  } catch {
    return tag;
  }
}

/**
 * The Settings picker's view of the voices: one entry per REAL voice, grouped
 * by exact locale (each group labelled with country AND code — "English —
 * United Kingdom (en-GB)"), every voice with a DISTINCT label. Needed because
 * Android's engine both names voices generically after their locale alone
 * ("inglés Australia" for every en-AU voice, in the device's language) AND
 * lists each voice several times (local/network twins + a default
 * placeholder): twins collapse into their offline variant, placeholders are
 * dropped, duplicated names become a stable "Voice N", and voices that need
 * connectivity are flagged "· online". Voices with real names (the web
 * engines') keep them. `voiceURI` values are untouched — saved selections
 * keep working.
 * @param {string} [lang] defaults to the active reading language
 * @returns {{ label: string, voices: { voiceURI: string, label: string }[] }[]}
 */
export function voiceGroupsForLang(lang = getReadingLang()) {
  const seen = new Set();
  const groups = new Map(); // locale tag → voices
  for (const v of voicesForLang(lang)) {
    const uri = v.voiceURI || v.name || '';
    if (!uri || seen.has(uri)) continue; // drop true duplicates
    seen.add(uri);
    const tag = (v.lang || lang || 'en').replace('_', '-');
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag).push(v);
  }

  const out = [];
  for (const [tag, all] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Google TTS inflates the list: every real voice appears TWICE (…-x-gba-local
    // and …-x-gba-network are the same voice, synthesized on-device vs in the
    // cloud), plus a "<locale>-language" placeholder for the engine default
    // (a duplicate of one of the real voices — and Auto already covers it).
    // Collapse to one entry per REAL voice, preferring the offline twin: it
    // works in airplane mode and costs no data.
    let voices = all.filter((v) => !new RegExp(`^${tag}-(language|default)$`, 'i').test(v.voiceURI || ''));
    if (!voices.length) voices = all; // the placeholder was all there was
    const byVoice = new Map(); // canonical id (twin suffix stripped) → best entry
    for (const v of voices) {
      const key = String(v.voiceURI).toLowerCase().replace(/-(local|network)$/, '');
      const held = byVoice.get(key);
      if (!held || (held.localService === false && v.localService === true)) byVoice.set(key, v);
    }
    voices = [...byVoice.entries()]
      // Stable order (the canonical id is stable) so "Voice N" keeps meaning
      // the same voice across openings.
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, v]) => v);

    const names = voices.map((v) => v.name || '');
    const entries = voices.map((v, i) => {
      // Generic: no name, a name shared with a sibling voice, or a Google-TTS
      // URI (…-x-<variant>-local|network) — those names are always the bare
      // locale, even when the voice is alone in its group.
      const generic =
        !v.name ||
        names.indexOf(v.name) !== names.lastIndexOf(v.name) ||
        /-x-[a-z0-9]+-(local|network)$/i.test(v.voiceURI || '');
      const base = generic ? `Voice ${i + 1}` : v.name;
      // Offline is the norm (and the preferred twin above) — only flag the
      // voices that NEED connectivity. localService undefined shows no flag.
      const net = v.localService === false ? ' · online' : '';
      return { voiceURI: v.voiceURI, label: `${base}${net}` };
    });
    out.push({ label: `${localeLabel(tag)} (${tag})`, voices: entries });
  }
  return out;
}
