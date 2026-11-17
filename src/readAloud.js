// Continuous read-aloud: from a starting word to the end of the book, fed to
// the speech engine ONE PARAGRAPH AT A TIME — never the whole text in a single
// utterance, which stalls/clips every engine on long inputs. Between paragraphs
// there is a short breathing gap (like a human reader taking the next
// paragraph); each paragraph re-reads the CURRENT voice settings, so a speed or
// voice change in Settings applies from the next paragraph on.
//
// The session ends when: the book runs out of paragraphs ('finished'), the reader
// stops it ('stopped' — including a stop landing inside the inter-paragraph gap,
// via onSpeechStop), any other speech starts ('interrupted' — a word's 🔊 replaces
// the running utterance, whose onEnd then reports completed=false), a new session
// replaces it ('replaced'), or the engine refuses to start ('failed'). The reason
// is handed to onEnd so the caller can tell "done" from "cut short" — the player
// (player.js) turns a cut-short session into a resumable pause.
//
// This module only SPEAKS and reports word boundaries; what a boundary does
// (highlight, page follow, pause/resume) is the caller's business (player.js).

import { speak, stopSpeaking, onSpeechStop } from './speech.js';

const PARAGRAPH_GAP_MS = 600; // the beat between paragraphs

let session = 0; // invalidates callbacks of a replaced/ended session
let gapTimer = null;
let activeEnd = null; // the running session's cleanup (highlight off, button restore)

/** Whether a continuous session is running (speaking OR inside the gap). */
export function isReading() {
  return activeEnd != null;
}

/** @typedef {'finished'|'stopped'|'interrupted'|'replaced'|'failed'} EndReason */

// End the session logically (idempotent). Never touches the engine — callers
// that need the voice silenced too go through stopReading().
/** @param {EndReason} [reason] */
function cancel(reason = 'stopped') {
  session += 1;
  if (gapTimer) {
    clearTimeout(gapTimer);
    gapTimer = null;
  }
  const end = activeEnd;
  activeEnd = null;
  end?.(reason);
}

/** Stop the continuous session and silence the voice. Safe to call anytime. */
export function stopReading() {
  cancel('stopped');
  stopSpeaking(); // no-op when the voice is already silent (a stop mid-gap)
}

// The pill's ⏹ only knows the speech engine; when its stop lands during the
// inter-paragraph gap there is no active speech whose onEnd could tell us — so
// every explicit stop request also ends the session.
onSpeechStop(() => cancel('stopped'));

/**
 * The word a boundary offset belongs to: the last word starting at or before
 * the offset (engines report word STARTS; offsets falling on punctuation keep
 * the previous word rather than flickering to none).
 * @param {{ start: number, end: number, wordIndex: number }[]} words
 * @param {number} offset
 * @returns {number | null} global word index
 */
export function wordAtOffset(words, offset) {
  let cur = null;
  for (const w of words) {
    if (w.start > offset) break;
    cur = w;
  }
  return cur ? cur.wordIndex : null;
}

/**
 * Start reading from `fromWord` to the end of the book, paragraph by paragraph.
 * Replaces any running session.
 * @param {{
 *   fromWord: number,
 *   getSlice: (wordIndex: number, opts: { continuing: boolean }) =>
 *     { text: string, words: { start: number, end: number, wordIndex: number }[] } | null,
 *   getLang: () => string,
 *   onWord?: (wordIndex: number | null, paragraphStart?: boolean) => void  the
 *     word being spoken; null when the session ends (clear the highlight).
 *     Fired once with paragraphStart=true as each paragraph BEGINS (even on
 *     engines without boundary events — so view-following always works), then
 *     per boundary as words are spoken,
 *   onEnd?: (reason: EndReason) => void  always fires exactly once, however the
 *     session ends, with WHY it ended,
 * }} opts `getSlice` is sentences.js's paragraph-speech lookup.
 */
export function startReading({ fromWord, getSlice, getLang, onWord, onEnd }) {
  cancel('replaced');
  const my = ++session;
  activeEnd = (reason) => {
    onWord?.(null);
    onEnd?.(reason);
  };

  const readParagraph = (wordIndex, continuing = false) => {
    const slice = getSlice(wordIndex, { continuing });
    if (!slice || !slice.words.length) {
      cancel('finished'); // ran out of book
      return;
    }
    const ok = speak(slice.text, getLang(), {
      onBoundary: (offset) => {
        if (my === session) onWord?.(wordAtOffset(slice.words, offset), false);
      },
      onEnd: (completed) => {
        if (my !== session) return;
        if (!completed) {
          cancel('interrupted'); // another speech (a word's 🔊) took over, or a stop
          return;
        }
        const next = slice.words[slice.words.length - 1].wordIndex + 1;
        gapTimer = setTimeout(() => {
          gapTimer = null;
          readParagraph(next, true);
        }, PARAGRAPH_GAP_MS);
      },
    });
    if (!ok) {
      cancel('failed');
      return;
    }
    // Announce the paragraph's first word immediately: the view aligns to the
    // new paragraph and the highlight is seeded even before the first boundary
    // event — and on engines that never fire boundaries at all.
    onWord?.(slice.words[0].wordIndex, true);
  };

  readParagraph(fromWord);
}
