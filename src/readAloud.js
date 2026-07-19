// Continuous read-aloud: from a starting word to the end of the book, fed to
// the speech engine ONE PARAGRAPH AT A TIME — never the whole text in a single
// utterance, which stalls/clips every engine on long inputs. Between paragraphs
// there is a short breathing gap (like a human reader taking the next
// paragraph); each paragraph re-reads the CURRENT voice settings, so a speed or
// voice change in Settings applies from the next paragraph on.
//
// The session ends when: the book runs out of paragraphs, the reader stops it
// (the bubble's ⏹ toggle or the pill — including a stop landing inside the
// inter-paragraph gap, via onSpeechStop), or any other speech starts (a word's
// 🔊 replaces the running utterance, whose onEnd then reports completed=false).
//
// This module only SPEAKS and reports word boundaries; what a boundary does
// (highlight, page follow) is the caller's business (gloss.js).

import { speak, stopSpeaking, onSpeechStop } from './speech.js';

const PARAGRAPH_GAP_MS = 600; // the beat between paragraphs

let session = 0; // invalidates callbacks of a replaced/ended session
let gapTimer = null;
let activeEnd = null; // the running session's cleanup (highlight off, button restore)

/** Whether a continuous session is running (speaking OR inside the gap). */
export function isReading() {
  return activeEnd != null;
}

// End the session logically (idempotent). Never touches the engine — callers
// that need the voice silenced too go through stopReading().
function cancel() {
  session += 1;
  if (gapTimer) {
    clearTimeout(gapTimer);
    gapTimer = null;
  }
  const end = activeEnd;
  activeEnd = null;
  end?.();
}

/** Stop the continuous session and silence the voice. Safe to call anytime. */
export function stopReading() {
  cancel();
  stopSpeaking(); // no-op when the voice is already silent (a stop mid-gap)
}

// The pill's ⏹ only knows the speech engine; when its stop lands during the
// inter-paragraph gap there is no active speech whose onEnd could tell us — so
// every explicit stop request also ends the session.
onSpeechStop(() => cancel());

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
 *   getSlice: (wordIndex: number) =>
 *     { text: string, words: { start: number, end: number, wordIndex: number }[] } | null,
 *   getLang: () => string,
 *   onWord?: (wordIndex: number | null, paragraphStart?: boolean) => void  the
 *     word being spoken; null when the session ends (clear the highlight).
 *     Fired once with paragraphStart=true as each paragraph BEGINS (even on
 *     engines without boundary events — so view-following always works), then
 *     per boundary as words are spoken,
 *   onEnd?: () => void  always fires exactly once, however the session ends,
 * }} opts `getSlice` is sentences.js's paragraph-speech lookup.
 */
export function startReading({ fromWord, getSlice, getLang, onWord, onEnd }) {
  cancel();
  const my = ++session;
  activeEnd = () => {
    onWord?.(null);
    onEnd?.();
  };

  const readParagraph = (wordIndex) => {
    const slice = getSlice(wordIndex);
    if (!slice || !slice.words.length) {
      cancel(); // ran out of book
      return;
    }
    const ok = speak(slice.text, getLang(), {
      onBoundary: (offset) => {
        if (my === session) onWord?.(wordAtOffset(slice.words, offset), false);
      },
      onEnd: (completed) => {
        if (my !== session) return;
        if (!completed) {
          cancel(); // stopped, or another speech (a word's 🔊) took over
          return;
        }
        const next = slice.words[slice.words.length - 1].wordIndex + 1;
        gapTimer = setTimeout(() => {
          gapTimer = null;
          readParagraph(next);
        }, PARAGRAPH_GAP_MS);
      },
    });
    if (!ok) {
      cancel();
      return;
    }
    // Announce the paragraph's first word immediately: the view aligns to the
    // new paragraph and the highlight is seeded even before the first boundary
    // event — and on engines that never fire boundaries at all.
    onWord?.(slice.words[0].wordIndex, true);
  };

  readParagraph(fromWord);
}
