// The speech BUBBLE: the single first look at anything in the reader. The
// interaction rule it exists for: gestures only ever open bubbles; actions live
// INSIDE them as visible buttons — a new feature must never become a new hidden
// gesture.
//
// Two modes share one element:
//  • Word bubble — word (state-colored) + part of speech, 🔊 (word, then its
//    definition once loaded), a 2-line definition, state chips to mark without
//    the popup, and ⋯ to expand into the full popup.
//  • Paragraph bubble — visible actions on the tapped word's paragraph:
//    read aloud (toggle), copy paragraph, copy word.
//  • Link bubble — a URL/e-mail token was tapped: open it (new tab) or copy it.
//    Navigation only ever happens from the visible button, never from the tap.
//
// The bubble only INFORMS and marks on explicit button press — same invariant
// as the popup. It points at its anchor with a tail and auto-hides when idle.

import { getQuickDefinition } from './definitions/index.js';
import { getReadingLang } from './settings.js';
import { canSpeak, speak, isSpeaking, stopSpeaking } from './speech.js';
import { copyWithToast } from './copy.js';
import { STATES } from './vocabulary.js';

const AUTO_HIDE_MS = 8000; // idle timeout; any interaction inside restarts it

let el = null;
let hideTimer = null;
let showId = 0; // invalidates stale async fills after hide/re-show

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
  hideTimer = setTimeout(hideGloss, AUTO_HIDE_MS);
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

  const pos = document.createElement('span');
  pos.className = 'gloss__pos';

  const speakBtn = speakToggle(
    // Word first, then its explanation once it has one — “oír la palabra y su
    // explicación” in a single control.
    () => (defText ? `${surface}. ${defText}` : surface),
    { label: `Pronounce ${surface} and its meaning` },
  );

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

  head.append(title, pos, ...(speakBtn ? [speakBtn] : []), more);

  // Definition: max two lines (CSS clamp); tapping it also expands.
  const def = document.createElement('p');
  def.className = 'gloss__def';
  def.addEventListener('click', () => {
    hideGloss();
    onExpand();
  });

  if (defText) {
    def.textContent = defText;
  } else {
    def.textContent = '…';
    getQuickDefinition(word, sentence)
      .then((d) => {
        if (myShow !== showId || el.hidden) return;
        defText = d?.explanation || '';
        def.textContent = defText || 'No definition — ⋯ has more options.';
        const p = (d?.kb?.pos || []).join(' · ');
        if (p) pos.textContent = p;
        position(span); // the real content changes the size
      })
      .catch(() => {
        if (myShow === showId && !el.hidden) def.textContent = 'No definition — ⋯ has more options.';
      });
  }

  // State chips: mark without opening the popup. The recolor is the feedback.
  const states = document.createElement('div');
  states.className = 'gloss__states';
  for (const s of STATES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'gloss__chip';
    chip.dataset.state = s;
    chip.textContent = s[0].toUpperCase() + s.slice(1);
    chip.setAttribute('aria-current', String(s === span.dataset.state));
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      hideGloss();
      onMark(s);
    });
    states.appendChild(chip);
  }

  el.append(head, def, states);
  position(span);
}

/**
 * Paragraph bubble: visible actions for the tapped word's paragraph.
 * @param {HTMLElement} span the word element (anchor)
 * @param {{ surface: string, paragraph: string }} opts
 */
export function showParagraphActions(span, { surface, paragraph }) {
  show(span);

  const head = document.createElement('div');
  head.className = 'gloss__head';
  const title = document.createElement('span');
  title.className = 'gloss__title';
  title.textContent = 'Paragraph';
  head.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'gloss__actions';

  if (canSpeak() && paragraph) {
    const read = actionButton('🔊 Read aloud', () => {
      if (isSpeaking()) {
        stopSpeaking();
        return;
      }
      const ok = speak(paragraph, getReadingLang(), {
        onEnd: () => {
          read.textContent = '🔊 Read aloud';
          if (!el.hidden) armAutoHide();
        },
      });
      if (ok) read.textContent = '⏹ Stop';
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

  el.append(head, actions);
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
  el.hidden = true;
  // A read-aloud in progress is left playing on purpose: dismissing the UI
  // shouldn't cut the audio mid-sentence; any 🔊 tap cancels it anyway.
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}
