// The read-aloud PLAYER: one state for the whole reader — idle, playing or paused —
// that every read-aloud control reflects (the top bar's ▶/⏸ + ⏹, the floating
// mini-player, the paragraph bubble's "Read from here"; see playerControls.js).
//
//   idle ──▶──▶ playing ──⏸──▶ paused ──▶──▶ playing
//     ▲            │                 │
//     └────⏹───────┴────────⏹────────┘     (and the book running out → idle)
//
// PAUSE IS LOGICAL. The Android TTS plugin has no pause at all, and Web Speech's
// pause()/resume() is unreliable across engines — so pausing stops the voice and
// remembers the last word spoken (boundary events report it), and resuming starts
// a NEW session from the beginning of that word's SENTENCE: the voice picks the
// phrase up whole instead of mid-clause. Resume is smart about where the reader is:
// if the paused word is no longer on screen (they paged or scrolled away while
// paused), ▶ reads from the top of what they are looking at instead.
//
// A session cut short by something else — a word's 🔊 taking over the voice —
// becomes a PAUSE, not a stop: listening, checking a word, then ▶ carries on.
//
// While playing, the screen is kept awake (Screen Wake Lock, where supported):
// listening hands-free must not end with the phone locking itself mid-chapter.
//
// The player knows nothing about pages or the DOM layout; the open document is
// ATTACHED with the callbacks that do (main.js#showDocument), and detached when the
// reader closes. Speaking is readAloud.js; this module is the state on top of it.

import { startReading, stopReading } from './readAloud.js';
import { canSpeak, suppressPill } from './speech.js';
import { logDiag } from './diagnostics.js';

/** @typedef {'idle'|'playing'|'paused'} PlayerState */

/**
 * @typedef {{
 *   getSlice: (wordIndex: number, opts?: { continuing?: boolean }) =>
 *     { text: string, words: { start: number, end: number, wordIndex: number }[] } | null,
 *   getSentenceStart: (wordIndex: number) => number,
 *   getFirstVisibleWord: () => number,
 *   isWordOnScreen: (wordIndex: number) => boolean,
 *   followWord: (wordIndex: number, ctx: { paragraphStart: boolean }) => void,
 *   getLang: () => string,
 * }} PlayerDocument
 */

/** @type {PlayerDocument | null} */
let doc = null;
/** @type {PlayerState} */
let state = 'idle';
let lastWord = null; // the word most recently spoken (where a pause resumes)
let token = 0; // invalidates the callbacks of a session the player ended itself
const listeners = new Set();

/**
 * The open document's hooks; replaces any previous one (and ends its session).
 * @param {PlayerDocument} hooks
 */
export function attachPlayer(hooks) {
  stopPlayer();
  doc = hooks;
  emit();
}

/** The reader closed: end any session and forget the document. */
export function detachPlayer() {
  stopPlayer();
  doc = null;
  emit();
}

/** Whether there is a document to read and a voice to read it with. */
export function canPlay() {
  return doc != null && canSpeak();
}

/** @returns {PlayerState} */
export function getPlayerState() {
  return state;
}

/** Subscribe to state changes (also fired on attach/detach). */
export function onPlayerChange(fn) {
  listeners.add(fn);
}

/** Read from a given word (the paragraph bubble's "Read from here"). */
export function playFrom(wordIndex) {
  if (!canPlay() || wordIndex == null) return;
  begin(wordIndex);
}

/**
 * The ▶/⏸ button: idle → read from the top of the screen; playing → pause;
 * paused → resume (from the paused sentence, or from the top of the screen when
 * the reader has moved away from it).
 */
export function togglePlay() {
  if (!canPlay()) return;
  if (state === 'playing') {
    pause();
    return;
  }
  if (state === 'paused' && lastWord != null && doc.isWordOnScreen(lastWord)) {
    begin(doc.getSentenceStart(lastWord));
    return;
  }
  begin(doc.getFirstVisibleWord());
}

/** ⏹: end the session (playing or paused) and silence the voice. */
export function stopPlayer() {
  token += 1; // the session's own onEnd must not re-settle the state
  const wasActive = state !== 'idle';
  stopReading();
  lastWord = null;
  highlight(null);
  setState('idle');
  if (wasActive) logDiag('player', 'stopped');
}

function pause() {
  token += 1;
  stopReading();
  // Keep the paused word painted, so the reader sees where ▶ will pick it up.
  highlight(lastWord);
  setState('paused');
}

function begin(fromWord) {
  const my = ++token;
  lastWord = fromWord;
  setState('playing');
  startReading({
    fromWord,
    getSlice: doc.getSlice,
    getLang: doc.getLang,
    onWord: (w, paragraphStart = false) => {
      if (my !== token) return;
      if (w == null) return; // the session's end clears nothing: settle() decides
      lastWord = w;
      // Follow first (a page turn / scroll may need to bring the word's span into
      // the DOM), then paint. followWord decides whether any movement is warranted.
      doc?.followWord(w, { paragraphStart });
      highlight(w);
    },
    onEnd: (reason) => {
      if (my !== token) return; // the player ended it (pause/stop/new session)
      settle(reason);
    },
  });
}

// A session ended on its own: the book ran out (or the engine refused) → idle;
// another speech cut in → a resumable pause at the last spoken word.
function settle(reason) {
  if (reason === 'interrupted' && lastWord != null) {
    highlight(lastWord);
    setState('paused');
    return;
  }
  if (reason === 'failed') logDiag('player', 'the speech engine refused to start');
  lastWord = null;
  highlight(null);
  setState('idle');
}

function setState(next) {
  if (next === state) return;
  state = next;
  // The generic speech pill would sit on top of the player's own controls.
  suppressPill(state !== 'idle');
  wakeLock(state === 'playing');
  emit();
}

function emit() {
  for (const fn of listeners) fn(state);
}

// --- Follow-along highlight ---------------------------------------------------------
// The spoken (or paused-on) word carries .is-speaking. Spans are looked up by global
// word index each time, so the highlight survives bubbles closing and page re-renders.
let spokenEl = null;
function highlight(wordIndex) {
  const next =
    wordIndex == null ? null : document.querySelector(`.word[data-i="${wordIndex}"]`);
  if (next === spokenEl) return;
  spokenEl?.classList.remove('is-speaking');
  spokenEl = next;
  spokenEl?.classList.add('is-speaking');
}

// --- Keep the screen on while playing -----------------------------------------------
let lock = null;
let wantLock = false;

async function wakeLock(on) {
  wantLock = on;
  if (!on) {
    const held = lock;
    lock = null;
    await held?.release().catch(() => {});
    return;
  }
  if (lock || !navigator.wakeLock?.request) return;
  try {
    const l = await navigator.wakeLock.request('screen');
    if (!wantLock) {
      l.release().catch(() => {}); // paused/stopped while the request was pending
      return;
    }
    lock = l;
    // The system drops the lock whenever the page is hidden; forget it so the
    // visibility handler below can take a new one when the page comes back.
    l.addEventListener('release', () => {
      if (lock === l) lock = null;
    });
  } catch (err) {
    logDiag('player', 'screen wake lock unavailable:', err?.name || '', err?.message || '');
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantLock && !lock) wakeLock(true);
});
