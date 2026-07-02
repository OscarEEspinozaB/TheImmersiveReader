// Speech with the browser's built-in voices (Web Speech API) — free,
// offline-capable, no server involved. Speaks single words (gloss bubble,
// Dictionary hub), word + explanation, and whole paragraphs (paragraph bubble).
// Voice and speed are user settings (Settings → Voice / Voice speed). Full
// continuous read-aloud with word highlighting is future work (docs/vision.md §3).
//
// Two engine quirks are worked around here:
//  • cancel() immediately followed by speak() clips the first words on several
//    engines (Chrome/Linux especially) — when something was playing, the new
//    speech starts after a short settle delay.
//  • Long single utterances can stall/clip; text is chunked into sentences and
//    queued, which also keeps cancellation responsive.

import { getReadingLang, getTtsRate, getTtsVoice } from './settings.js';

/** Whether this browser can speak at all. */
export function canSpeak() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

const CANCEL_SETTLE_MS = 120; // beat between cancel() and the next speak()

// --- Voices ---------------------------------------------------------------------
// getVoices() is empty until the engine has loaded them (async on Chrome), so
// cache the list and keep it fresh via voiceschanged. Touching getVoices() at
// module load also warms the engine, which helps against first-utterance clipping.
let voices = [];
function refreshVoices() {
  voices = window.speechSynthesis.getVoices() || [];
}
if (canSpeak()) {
  refreshVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
}

/** Installed voices, freshest available list. */
export function listVoices() {
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

// Sentence chunks for queueing (one utterance per sentence).
function chunksOf(text, lang) {
  try {
    const out = [];
    for (const s of new Intl.Segmenter(lang, { granularity: 'sentence' }).segment(text)) {
      const t = s.segment.trim();
      if (t) out.push(t);
    }
    return out.length ? out : [text];
  } catch {
    return [text];
  }
}

// --- "Now playing" pill ----------------------------------------------------------
// The stop control lives in transient UI (the bubble auto-hides), so while
// speech is active a small fixed pill shows at the bottom: it both signals that
// something is playing and stops it on tap. It appears only for speech that
// lasts past a beat, so a quick word pronunciation doesn't flash UI.
const PILL_DELAY_MS = 300;
let pill = null;
let pillTimer = null;

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
  if (pill) pill.hidden = true;
}

// --- Speaking -------------------------------------------------------------------
let speakToken = 0; // invalidates the in-flight speech's handlers
let activeOnEnd = null;
let active = false;
let lastCancelAt = 0;
// HARD references to every queued utterance: Chrome garbage-collects utterance
// objects that JS no longer references — even queued/playing ones — which mutes
// them and never fires their events. Cleared only when a speech run ends.
let liveUtterances = [];

// End the current speech logically: whoever was playing gets its onEnd (so play
// buttons always restore), and stale utterance events become no-ops.
function invalidate() {
  speakToken += 1;
  active = false;
  liveUtterances = [];
  hidePill();
  const cb = activeOnEnd;
  activeOnEnd = null;
  cb?.();
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
 * @param {{ rate?: number, onEnd?: () => void }} [opts] `onEnd` always fires —
 *   on natural end AND when the speech is cancelled/replaced — so callers can
 *   rely on it to restore a play button.
 * @returns {boolean} whether speech started
 */
export function speak(text, lang, { rate = getTtsRate(), onEnd } = {}) {
  if (!canSpeak() || !text) return false;
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
      const u = new SpeechSynthesisUtterance(chunk);
      u.lang = lang || 'en';
      if (voice) u.voice = voice;
      u.rate = rate;
      let done = false; // some engines fire BOTH end and error for one utterance
      u.onend = u.onerror = () => {
        if (done || token !== speakToken) return;
        done = true;
        remaining -= 1;
        if (remaining === 0) {
          active = false;
          liveUtterances = [];
          hidePill();
          const cb = activeOnEnd;
          activeOnEnd = null;
          cb?.();
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

/** Stop whatever is being spoken (no-op when silent). Fires its onEnd. */
export function stopSpeaking() {
  invalidate();
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
