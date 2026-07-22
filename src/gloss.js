// The speech BUBBLE: the single first look at anything in the reader. The
// interaction rule it exists for: gestures only ever open bubbles; actions live
// INSIDE them as visible buttons — a new feature must never become a new hidden
// gesture.
//
// Two modes share one element:
//  • Word bubble — word (state-colored) + part of speech, 🔊 (the word alone —
//    hearing its pronunciation must not drag the whole definition along), a
//    2-line definition, the word's FAMILY (its paradigm, each form in its own
//    state's color — so a red "gone" is seen next to a white "go" the reader
//    already knows), state chips to mark without the popup, and ⋯ to expand
//    into the full popup.
//  • Paragraph bubble — visible actions on the tapped word's paragraph:
//    read aloud FROM THE TAPPED WORD, continuously to the end of the book
//    (paragraph by paragraph, readAloud.js), with each word highlighted as it
//    is spoken and the page following the voice; copy paragraph; copy word;
//    and TRANSLATE the tapped word's SENTENCE — one sentence, never the
//    paragraph. That lives here, and only here, on purpose: it is the reader
//    deliberately checking "did I understand this?" after reading, and it is kept
//    expensive (one double tap buys one sentence) so the book cannot be swept
//    into the reader's own language a paragraph at a time. The word bubble
//    translates the word and its dictionary explanation, never the book.
//  • Link bubble — a URL/e-mail token was tapped: open it (new tab) or copy it.
//    Navigation only ever happens from the visible button, never from the tap.
//
// The bubble only INFORMS and marks on explicit button press — same invariant
// as the popup. It points at its anchor with a tail and auto-hides when idle.

import { getQuickDefinition, translateFragment, isMlkitAvailable } from './definitions/index.js';
import { renderFamilyStrip, posSummary } from './kbDetails.js';
import { getReadingLang, getReadingLangName, getLanguage } from './settings.js';
import { canSpeak, speak, isSpeaking, stopSpeaking } from './speech.js';
import { isReading, startReading, stopReading } from './readAloud.js';
import { copyWithToast } from './copy.js';
import { MARK_ORDER } from './vocabulary.js';

const AUTO_HIDE_MS = 8000; // idle timeout; any interaction inside restarts it

let el = null;
let hideTimer = null;
let showId = 0; // invalidates stale async fills after hide/re-show
let pinned = false; // an answer was requested: this bubble no longer auto-hides

function ensureEl() {
  if (el) return;
  el = document.createElement('div');
  el.className = 'gloss';
  el.hidden = true;
  document.body.appendChild(el);

  // Dismiss on any interaction elsewhere (a page turn, another word, scrolling);
  // interacting INSIDE the bubble keeps it alive instead.
  document.addEventListener('pointerdown', (e) => {
    if (el.hidden) return;
    if (el.contains(e.target)) armAutoHide();
    else hideGloss();
  });
}

function armAutoHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  if (pinned) return; // an answer the reader asked for is on screen: it stays
  hideTimer = setTimeout(hideGloss, AUTO_HIDE_MS);
}

/**
 * Stop auto-hiding for good, until this bubble is dismissed. The idle timeout is
 * right for a bubble the reader only glanced at, and wrong the moment they ask it a
 * question: a slow first answer (a model download) would time out under the await,
 * and a long one would vanish while they were still reading it. Cleared by show()
 * and hideGloss(), so it never leaks into the next bubble.
 */
function pinOpen() {
  pinned = true;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
}

// Place the bubble near the anchor word, tail pointing at it: below the word
// when there is room, above otherwise; the tail slides along the bubble edge to
// stay centered on the word even when the bubble is clamped to the viewport.
function position(anchor) {
  const margin = 8;
  const gap = 10; // leaves room for the tail
  const rect = anchor.getBoundingClientRect();
  el.style.left = '0px';
  el.style.top = '0px';
  const width = el.offsetWidth;
  const height = el.offsetHeight;

  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
  const below = rect.bottom + gap + height + margin <= window.innerHeight;
  const top = below ? rect.bottom + gap : Math.max(margin, rect.top - gap - height);
  el.classList.toggle('gloss--below', below);
  el.classList.toggle('gloss--above', !below);

  const anchorCenter = rect.left + rect.width / 2;
  const tailX = Math.max(14, Math.min(anchorCenter - left, width - 14));
  el.style.setProperty('--tail-x', `${tailX}px`);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function show(anchor) {
  ensureEl();
  el.replaceChildren();
  el.hidden = false;
  pinned = false; // a fresh bubble is a glance again until something is asked of it
  armAutoHide();
  return ++showId;
}

// A 🔊/⏹ toggle: speaks `getText()` and shows ⏹ while playing. `getText` is
// resolved at click time (the word bubble's definition arrives after the show).
function speakToggle(getText, { label }) {
  if (!canSpeak()) return null;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'speak-btn';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.textContent = '🔊';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isSpeaking()) {
      stopSpeaking(); // onEnd restores the icon
      return;
    }
    const ok = speak(getText(), getReadingLang(), {
      onEnd: () => {
        btn.textContent = '🔊';
        if (!el.hidden) armAutoHide();
      },
    });
    if (ok) btn.textContent = '⏹';
  });
  return btn;
}

function actionButton(label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'gloss__action';
  btn.textContent = label;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

/**
 * Word bubble.
 * @param {HTMLElement} span the word element (anchor)
 * @param {{ surface: string, word: string, sentence: string,
 *           parts?: string[] | null,
 *           onExpand: () => void,
 *           onMark: (state: string) => void }} opts
 *   `word` is the cache/lookup key (lemma; contractions use their surface);
 *   `parts` the contraction's component lemmas when it is one — shown instantly
 *   as "didn't = did + not" with no lookup. `onMark` applies a state to the word
 *   (all occurrences; contraction parts included) — marking hides the bubble,
 *   the recolored text is the feedback.
 */
export function showGloss(span, { surface, word, sentence, parts = null, onExpand, onMark }) {
  const myShow = show(span);
  let defText = parts && parts.length ? `${surface} = ${parts.join(' + ')}` : '';

  // Head: word (state-colored) · part of speech · 🔊 · ⋯
  const head = document.createElement('div');
  head.className = 'gloss__head';

  const title = document.createElement('span');
  title.className = 'gloss__word word';
  title.dataset.state = span.dataset.state;
  title.textContent = surface;

  // Current-state legend: the word already carries the state's color; this names
  // it, so the marking chips below can omit the current state (only the OTHER
  // three are offered).
  const stateTag = document.createElement('span');
  stateTag.className = 'gloss__state-tag';
  stateTag.dataset.state = span.dataset.state;
  stateTag.textContent = span.dataset.state[0].toUpperCase() + span.dataset.state.slice(1);

  const pos = document.createElement('span');
  pos.className = 'gloss__pos';

  // The word ALONE: pronunciation is what the 🔊 is for; the definition is
  // already on screen and reading it out loud was noise (user feedback).
  const speakBtn = speakToggle(() => surface, { label: `Pronounce ${surface}` });

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'gloss__more';
  more.title = 'More (contexts, AI, explain in my language)';
  more.setAttribute('aria-label', 'More about this word');
  more.textContent = '⋯';
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    hideGloss();
    onExpand();
  });

  head.append(title, stateTag, pos, ...(speakBtn ? [speakBtn] : []), more);

  // Definition: max two lines (CSS clamp); tapping it also expands.
  const def = document.createElement('p');
  def.className = 'gloss__def';
  def.addEventListener('click', () => {
    hideGloss();
    onExpand();
  });

  // The word's family (go · goes · going · went · gone), each form in the color of
  // the state IT has: the word being read is never a loose word, it is one form of
  // something the reader may already half-know. Filled in with the definition.
  const family = document.createElement('div');

  if (defText) {
    def.textContent = defText;
  } else {
    def.textContent = '…';
    getQuickDefinition(word, sentence)
      .then((d) => {
        if (myShow !== showId || el.hidden) return;
        defText = d?.explanation || '';
        // A freedict answer on a non-English book is an English translation, not a
        // same-language definition — flag it so a "orphan" over "huérfano" reads as
        // a translation, not a broken dictionary.
        const isTranslation = d?.source === 'freedict' && getReadingLang() !== 'en';
        def.textContent = defText
          ? (isTranslation ? `EN: ${defText}` : defText)
          : 'No definition — ⋯ has more options.';
        // Part of speech and IPA pronunciation (freedict carries one) on one line.
        const meta = [posSummary(d?.kb?.pos), d?.pronunciation].filter(Boolean);
        if (meta.length) pos.textContent = meta.join(' · ');
        const strip = renderFamilyStrip(d?.kb, word);
        if (strip) family.appendChild(strip);
        position(span); // the real content changes the size
      })
      .catch(() => {
        if (myShow === showId && !el.hidden) def.textContent = 'No definition — ⋯ has more options.';
      });
  }

  // State chips: mark without opening the popup (the recolor is the feedback).
  // Always three — the word's current state is the legend above, not a button, so
  // every chip is a real "switch to" action (fixed order, minus the current state).
  const states = document.createElement('div');
  states.className = 'gloss__states';
  for (const s of MARK_ORDER) {
    if (s === span.dataset.state) continue;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'gloss__chip';
    chip.dataset.state = s;
    chip.textContent = s[0].toUpperCase() + s.slice(1);
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      hideGloss();
      onMark(s);
    });
    states.appendChild(chip);
  }

  el.append(head, def, family, states);
  position(span);
}

// Read-aloud follow-along (MS Edge style): the word being spoken carries
// .is-speaking. Spans are looked up by global word index at each boundary, so
// the highlight survives the bubble hiding and a page re-render. Returns the
// span (null when that word is not in the DOM — the voice ran past the page).
let spokenEl = null;
function highlightSpokenWord(wordIndex) {
  const next =
    wordIndex == null ? null : document.querySelector(`.word[data-i="${wordIndex}"]`);
  if (next !== spokenEl) {
    spokenEl?.classList.remove('is-speaking');
    spokenEl = next;
    spokenEl?.classList.add('is-speaking');
  }
  return next;
}

/**
 * Paragraph bubble: visible actions for the tapped word's paragraph.
 * @param {HTMLElement} span the word element (anchor)
 * @param {{ surface: string, paragraph: string, sentence?: string,
 *           wordIndex?: number | null,
 *           getParagraphSpeech?: ((wordIndex: number) =>
 *             { text: string, words: { start: number, end: number, wordIndex: number }[] } | null) | null,
 *           followWord?: ((wordIndex: number,
 *                          ctx: { paragraphStart: boolean }) => void) | null }} opts
 *   With `getParagraphSpeech` (sentences.js), Read from here runs a CONTINUOUS
 *   session (readAloud.js): from the tapped word to the end of the book,
 *   paragraph by paragraph, highlighting the spoken word; `followWord` brings a
 *   word outside the rendered page into view (page turn / scroll) so the
 *   highlight can keep following. Without it, the button falls back to a
 *   one-shot read of `paragraph`. Copying always copies the whole paragraph.
 *   `sentence` is the tapped word's own sentence — the ONLY thing Translate ever
 *   sends, deliberately narrower than everything else this bubble acts on.
 */
export function showParagraphActions(
  span,
  { surface, paragraph, sentence = '', wordIndex = null, getParagraphSpeech = null, followWord = null },
) {
  show(span);

  const head = document.createElement('div');
  head.className = 'gloss__head';
  const title = document.createElement('span');
  title.className = 'gloss__title';
  title.textContent = 'Paragraph';
  head.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'gloss__actions';

  const continuous = getParagraphSpeech != null && wordIndex != null;
  if (canSpeak() && (continuous || paragraph)) {
    const read = actionButton('🔊 Read from here', () => {
      if (isReading() || isSpeaking()) {
        stopReading(); // also silences a plain one-shot speech
        return;
      }
      const restore = () => {
        read.textContent = '🔊 Read from here';
        if (!el.hidden) armAutoHide();
      };
      read.textContent = '⏹ Stop';
      if (!continuous) {
        if (!speak(paragraph, getReadingLang(), { onEnd: restore })) restore();
        return;
      }
      startReading({
        fromWord: wordIndex,
        getSlice: getParagraphSpeech,
        getLang: getReadingLang,
        onWord: (w, paragraphStart = false) => {
          // Follow first (page turn / scroll may need to bring the word's span
          // into the DOM), then paint. followWord decides whether any movement
          // is warranted — asked once per boundary, never loops.
          if (w != null && followWord) followWord(w, { paragraphStart });
          highlightSpokenWord(w);
        },
        onEnd: restore,
      });
    });
    actions.appendChild(read);
  }
  if (paragraph) {
    actions.appendChild(actionButton('Copy paragraph', () => {
      hideGloss();
      copyWithToast(paragraph, 'Paragraph');
    }));
  }
  actions.appendChild(actionButton('Copy word', () => {
    hideGloss();
    copyWithToast(surface, 'Word');
  }));

  // The comprehension check: read it first, then ask what it said. The result
  // replaces nothing — it appears UNDER the text, which stays where it is, so the
  // reader compares their own reading against it.
  //
  // It translates ONE SENTENCE — the one holding the tapped word, period to period —
  // never the paragraph. That is a deliberate limit, not a technical one: translation
  // has to stay expensive enough that it is not worth leaning on. One double tap buys
  // one sentence, so a reader can check a passage they struggled with and cannot
  // sweep the book into their own language a paragraph at a time. It also happens to
  // be what the small on-device model translates best.
  const language = getLanguage();
  const result = document.createElement('p');
  result.className = 'gloss__translation';
  result.hidden = true;
  if (sentence && isMlkitAvailable() && getReadingLangName() !== language) {
    const translate = actionButton('Translate this sentence', async () => {
      const mine = showId;
      translate.disabled = true;
      translate.textContent = 'Translating…';
      result.hidden = false;
      result.textContent = '…';
      // A first run downloads a model: the idle timer must not eat a result the
      // reader explicitly asked for, and a pinned bubble stays until dismissed.
      pinOpen();
      const text = await translateFragment(sentence, language);
      if (mine !== showId || el.hidden) return; // the bubble moved on meanwhile
      result.textContent = text || `Could not translate (is the ${language} model downloaded?).`;
      translate.remove(); // answered: the button has nothing left to do
      position(span); // the bubble just grew — re-anchor it to the word
    });
    actions.appendChild(translate);
  }

  el.append(head, actions, result);
  position(span);
}

/**
 * Link bubble: a URL / e-mail token was tapped. Shows the link and two visible
 * actions — open in a NEW tab (the reader never navigates away) and copy.
 * @param {HTMLElement} span the link element (anchor)
 * @param {{ url: string }} opts the link exactly as printed in the book
 */
export function showLinkActions(span, { url }) {
  show(span);

  // What the Open button will actually load: the text as-is when it already has a
  // scheme, mailto: for e-mail addresses, https:// for scheme-less www. links.
  const href = /^[a-z][a-z0-9+.-]*:\/\//i.test(url)
    ? url
    : url.includes('@')
      ? `mailto:${url}`
      : `https://${url}`;

  const head = document.createElement('div');
  head.className = 'gloss__head';
  const title = document.createElement('span');
  title.className = 'gloss__title';
  title.textContent = 'Link';
  head.appendChild(title);

  const target = document.createElement('p');
  target.className = 'gloss__url';
  target.textContent = url;

  const actions = document.createElement('div');
  actions.className = 'gloss__actions';
  actions.appendChild(actionButton('Open in new tab ↗', () => {
    hideGloss();
    window.open(href, '_blank', 'noopener');
  }));
  actions.appendChild(actionButton('Copy link', () => {
    hideGloss();
    copyWithToast(url, 'Link');
  }));

  el.append(head, target, actions);
  position(span);
}

export function hideGloss() {
  if (!el || el.hidden) return;
  showId += 1;
  pinned = false;
  el.hidden = true;
  // A read-aloud in progress is left playing on purpose: dismissing the UI
  // shouldn't cut the audio mid-sentence; any 🔊 tap cancels it anyway.
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}
