// Marking: wire word interaction to vocabulary state changes.
//
// - Click a word -> popup to pick Known / Learning / Unknown.
// - Keys 1/2/3 set the state of the focused word directly.
// In every case we persist the new state and recolor ALL occurrences of that
// word (keyed by its normalized form), not just the one clicked.

import { setState, getState, normalizeSurface } from './vocabulary.js';
import { recolorWord } from './reader/render.js';
import { WordPopup } from './popup.js';
import {
  getQuickDefinition,
  getAiDefinition,
  getAiDefinitionInLanguage,
  decomposeContraction,
  isAiAvailable,
  requestKbBuild,
  reRefineWord,
} from './definitions/index.js';
import {
  getContraction,
  isUnknownContraction,
  learnContraction,
  aggregateStates as aggregateContraction,
} from './contractions.js';
import { getLanguage } from './settings.js';
import { showGloss, showParagraphActions, showLinkActions, hideGloss } from './gloss.js';
import {
  getCached,
  cacheDictionary,
  getAiList,
  getAiForSentence,
  pushAi,
  getCachedLang,
  cacheLang,
} from './definitionsCache.js';

const KEY_TO_STATE = { 1: 'known', 2: 'learning', 3: 'unknown', 4: 'discarded' };

// How long the pointer must be held on a word before its BUBBLE opens, by state.
// A light counterweight that grows with how well the word is known — enough to
// signal intent, never the heavy "opening weight" that used to gate the popup
// (the bubble is a light glance). Unknown opens at once (250 ms is the
// double-tap detection window, not a gate); learning asks for a minimal beat;
// known asks for a deliberate 1 s so accidental touches never interrupt
// fluent reading. Discarded (exempt) is a resolved word like known, so it gets
// the same deliberate hold — accidental taps never reopen it (reversing a wrong
// discard is a hold here, or the Dictionary hub).
const OPEN_HOLD_MS = { unknown: 250, learning: 500, known: 1000, discarded: 1000 };

// MULTI_TAP_MS is the window to wait for a second tap (and so the delay before a
// single tap opens the word bubble). A double tap opens the paragraph bubble.
// Arming (the hold fill) only shows for the slow states, so a quick press on an
// unknown word still feels instant.
const MULTI_TAP_MS = 250;
const ARMING_MIN_MS = 400;

/**
 * @param {HTMLElement} flow the rendered content (delegation root)
 * @param {{
 *   getSentence?: (wordIndex: number) => string,
 *   getParagraph?: (wordIndex: number) => string,
 *   getParagraphSpeech?: (wordIndex: number) =>
 *     { text: string, words: { start: number, end: number, wordIndex: number }[] } | null,
 *   followWord?: (wordIndex: number) => void,
 *   book?: { uid?: string },
 * }} [opts]
 *   `book` identifies the open book so server-cached AI answers are stored/shared
 *   per book (the sentence is the real key; book + page are organizing metadata).
 *   `getParagraph` backs the paragraph bubble's copy action; `getParagraphSpeech`
 *   its continuous read-aloud (paragraph slices from any word, with per-word
 *   offsets for the follow-along highlight — see sentences.js); `followWord`
 *   brings an off-page word into view so the highlight can follow the voice.
 */
// ONE popup (and one request counter) for the whole app. attachMarking runs on
// every re-render (book open, reading-mode or font change), and each WordPopup
// permanently adds an element to <body> plus a document-level dismiss listener —
// a fresh instance per call would accumulate them forever. All per-word state is
// set in popup.show(), so reuse across documents is safe; the shared requestId
// also invalidates any lookup still in flight from a previous render.
let popup = null;
let requestId = 0;

/** Close the shared word popup if it is open (used by the hardware back button). */
export function hidePopup() {
  popup?.hide();
}

export function attachMarking(
  flow,
  {
    getSentence = () => '',
    getParagraph = () => '',
    getParagraphSpeech = null,
    followWord = null,
    book = {},
  } = {},
) {
  if (!popup) popup = new WordPopup();
  popup.hide(); // a popup left open by the previous render anchors to a dead span
  requestId += 1;

  // Apply a state to a word span. For a contraction the state is applied to ALL
  // of its component lemmas at once (one gesture, both parts); for an ordinary
  // word, to its single key.
  const apply = (span, state) => {
    const lemmas = span.dataset.parts ? span.dataset.parts.split(' ') : [span.dataset.word];
    for (const lemma of lemmas) {
      if (!lemma) continue;
      setState(lemma, state);
      recolorWord(flow, lemma, state);
    }
  };

  // Set up the AI (Ollama) panel. The AI is NEVER auto-queried — for every word
  // state it waits for the user's explicit request. We show any already-cached
  // contexts immediately (no LLM call) and, when the AI is reachable, offer a
  // button to look up the CURRENT context. `surface` is the original surface form
  // sent to the AI (so it sees "Dursley's" / "didn't", not the stripped key).
  const setupAi = (word, surface, sentence, bookCtx, active) => {
    popup.setAiList(getAiList(word), sentence); // cached contexts only, no lookup

    // Once a context has an answer it is served from the store forever — the AI is
    // never re-queried (no "ask again"). So if this context already has one, just
    // show it and offer no button. The first answer for a context is generated by
    // the server (and cached there for every device); later it comes back instantly.
    if (getAiForSentence(word, sentence)) return;

    const ask = () => {
      popup.hideAiButton();
      popup.setAiList(getAiList(word), sentence, true); // "Looking up IA…" row
      getAiDefinition(surface, sentence, bookCtx)
        .then((def) => {
          if (!active()) return;
          if (def) {
            pushAi(word, sentence, def);
            popup.setAiList(getAiList(word), sentence, false); // answer shown, no button
          } else {
            // Nothing was generated (AI unreachable / error): surface an error row
            // and re-offer the button, since retrying a FAILED lookup is not a
            // regeneration of an existing answer.
            popup.setAiList(getAiList(word), sentence, false, true);
            popup.showAiButton('Ask AI (this context)', ask);
          }
        })
        .catch(() => {
          if (!active()) return;
          popup.setAiList(getAiList(word), sentence, false, true);
          popup.showAiButton('Ask AI (this context)', ask);
        });
    };

    isAiAvailable().then((ok) => {
      if (ok && active()) popup.showAiButton('Ask AI (this context)', ask);
    });
  };

  // Read-through build: when the shown entry is not the KB's already-refined one,
  // ask the KB to refine + store it in the BACKGROUND (the reader never waits).
  // If the build finishes while the popup is still open, upgrade the shown
  // definition to the refined one; either way the next lookup serves it from the
  // KB. Contractions are handled by their own breakdown, not the KB, so skip them.
  const buildInBackground = (word, def, sentence, active) => {
    if (!def || def.source === 'contraction') return;
    if (def.source === 'kb' && def.refined) return; // already built — nothing to do
    requestKbBuild(word).then((built) => {
      if (!built || !active()) return;
      getQuickDefinition(word, sentence).then((fresh) => {
        if (!fresh || !active()) return;
        cacheDictionary(word, fresh);
        popup.setQuick(fresh, word);
      });
    });
  };

  // Load the quick dictionary for a word. The AI is separate and on-demand
  // (setupAi), so this never triggers a blocking LLM call — but a non-refined entry
  // kicks off a background KB build (read-through).
  //
  // Caching is stale-while-revalidate for KB entries: a word's KB entry can be
  // rebuilt (read-through, or a re-refine with a stronger model), so a cached KB
  // definition may be out of date. We show the cached one instantly, then always
  // re-query the (local, fast) KB and update if it changed. Online/local/contraction
  // definitions are stable, so those are trusted from cache without a refetch.
  const loadDictionary = (word, sentence, active) => {
    const cached = getCached(word)?.dictionary;

    if (cached && cached.source !== 'kb') {
      popup.setQuick(cached, word);
      buildInBackground(word, cached, sentence, active);
      return;
    }

    if (cached) popup.setQuick(cached, word); // KB cache: show instantly, then revalidate
    else popup.quickLoading();

    getQuickDefinition(word, sentence)
      .then((def) => {
        if (!active()) return;
        if (def) {
          cacheDictionary(word, def);
          popup.setQuick(def, word);
          buildInBackground(word, def, sentence, active);
        } else if (!cached) {
          popup.setQuickLinks(word);
          buildInBackground(word, { source: 'miss' }, sentence, active);
        }
      })
      .catch(() => active() && !cached && popup.setQuickLinks(word));
  };

  // Show the contraction breakdown ("didn't = did + not") with each part's
  // current state. Called when opening a contraction and after the AI learns one.
  const showBreakdown = (span) => {
    const c = getContraction(span.textContent);
    if (!c) return;
    popup.setBreakdown(
      span.textContent,
      c.parts.map((lemma) => ({ lemma, state: getState(lemma) })),
      c.note,
    );
  };

  // Turn ordinary word spans into contraction spans once the AI has decomposed
  // them (every occurrence of the same surface on the current page).
  const convertSpansToContraction = (surface, lemmas) => {
    const target = surface.toLowerCase();
    for (const el of flow.querySelectorAll('.word')) {
      if (el.dataset.parts) continue;
      if (el.textContent.toLowerCase() !== target) continue;
      delete el.dataset.word;
      el.dataset.parts = lemmas.join(' ');
      el.dataset.state = aggregateContraction(lemmas);
    }
  };

  const openPopup = (span) => {
    hideGloss(); // the popup supersedes a gloss still on screen
    const surface = span.textContent;      // original surface form for AI prompts
    const state = span.dataset.state;
    const wordIndex = Number(span.dataset.i);
    const sentence = getSentence(wordIndex);
    // Book context for the server's per-book AI cache. `page` is the word index of
    // the consulted word — an informational hint; the sentence is the real key.
    const bookCtx = { uid: book.uid || '', page: wordIndex };
    const isContraction = !!span.dataset.parts;
    // Cache key: ordinary words use their lemma; contractions use their surface
    // (they have no lemma of their own), so cache/AI history is per contraction.
    const word = isContraction ? normalizeSurface(surface) : span.dataset.word;
    popup.show(span, state, (newState) => apply(span, newState));

    const myRequest = ++requestId;
    const active = () => myRequest === requestId && popup.visible;

    // The two regenerate actions the popup offers a ↻ for — both real LLM calls the
    // reader triggers when an answer came out wrong. Registered before the slots
    // load, since the ↻ is decided as each answer is rendered. The `active()` guard
    // drops a result whose popup was already dismissed or moved to another word.
    const regenDictionary = async () => {
      const ok = await reRefineWord(word);
      if (!ok || !active()) return;
      const fresh = await getQuickDefinition(word, sentence);
      if (fresh && active()) {
        cacheDictionary(word, fresh);
        popup.setQuick(fresh, word);
      }
    };
    const regenAi = async () => {
      popup.setAiList(getAiList(word), sentence, true); // "Looking up IA…" row
      const def = await getAiDefinition(surface, sentence, bookCtx, { force: true });
      if (!active()) return;
      if (def) {
        pushAi(word, sentence, def); // replaces the stored answer for this sentence
        popup.setAiList(getAiList(word), sentence, false);
      } else {
        popup.setAiList(getAiList(word), sentence, false, true);
      }
    };
    // The reader's native language — needed both for the rescue below and for its ↻.
    const language = getLanguage();
    const regenLang = async () => {
      popup.langLoading(`Explaining in ${language}…`); // loading state while it re-runs
      const def = await getAiDefinitionInLanguage(surface, sentence, language, bookCtx, { force: true });
      if (!active()) return;
      if (def) {
        cacheLang(word, language, sentence, def); // replaces the stored native answer
        popup.setLang(def);
      } else {
        popup.setLang(null);
      }
    };
    popup.setRegenerators({ onRerefine: regenDictionary, onRegenAi: regenAi, onRegenLang: regenLang });

    if (isContraction) showBreakdown(span);

    // On-demand native-language rescue. Like the AI panel, it is generated once per
    // context and then served from the store forever — never re-explained. So if
    // this context already has an explanation, show it directly (no button); only a
    // context without one offers the button, and only when the AI is reachable.
    const cachedLang = getCachedLang(word, language, sentence);
    if (cachedLang) {
      popup.setLang(cachedLang); // already explained for this context — just show it
    } else {
      const explain = () => {
        popup.langLoading(`Explaining in ${language}…`); // hides the button
        getAiDefinitionInLanguage(surface, sentence, language, bookCtx)
          .then((def) => {
            if (!active()) return;
            if (def) {
              cacheLang(word, language, sentence, def);
              popup.setLang(def); // explanation shown, no button
            } else {
              // Failed lookup: re-offer the button so it can be retried (nothing
              // was stored, so this is not a regeneration of an existing answer).
              popup.setLang(null);
              popup.showLangButton(`Explain in ${language}`, explain);
            }
          })
          .catch(() => {
            if (!active()) return;
            popup.setLang(null);
            popup.showLangButton(`Explain in ${language}`, explain);
          });
      };
      isAiAvailable().then((ok) => {
        if (ok && active()) popup.showLangButton(`Explain in ${language}`, explain);
      });
    }

    // Unknown contraction (looks like one but isn't in the registry yet): ask the
    // AI to decompose it in context, then add it to the registry, recolor it, and
    // reveal the breakdown — this is how the registry grows as words are consulted.
    if (!isContraction && isUnknownContraction(surface)) {
      decomposeContraction(surface, sentence).then((res) => {
        if (!res || !active()) return;
        learnContraction(surface, res.parts, res.note);
        convertSpansToContraction(surface, res.parts);
        if (active()) showBreakdown(span);
      });
    }

    // The AI is always on demand (user request) for EVERY state — show cached
    // contexts now and, when reachable, a button to look up the current one.
    setupAi(word, surface, sentence, bookCtx, active);

    if (state === 'known' || state === 'discarded') {
      // Known/discarded (resolved words): never auto-fetch the dictionary either.
      // Offer a button to look it up if the user wants (instant from cache). State
      // is NOT changed.
      popup.showLookupButton(() => {
        popup.hideLookupButton();
        loadDictionary(word, sentence, active);
      });
      return;
    }

    // Learning / Unknown: the local dictionary still loads automatically (instant,
    // immersion-friendly); only the AI waits for a request.
    loadDictionary(word, sentence, active);
  };

  // Interaction model — gestures only open BUBBLES; actions are visible buttons
  // inside them (gloss.js), so new features never become new hidden gestures:
  //  • Single tap on an UNKNOWN or LEARNING word → its word bubble (definition,
  //    🔊, state chips, ⋯ → full popup). Tapping a KNOWN or DISCARDED word does
  //    nothing — both are resolved; fluent reading must not be interrupted.
  //  • Press-and-HOLD any word (incl. known) → the same word bubble; the required
  //    hold grows with how well the word is known (OPEN_HOLD_MS) and a fill shows
  //    the time remaining. The full popup only ever opens FROM the bubble.
  //  • Double tap → the paragraph bubble (read aloud from the tapped word /
  //    copy paragraph / copy word).
  // Holding and tapping never collide: a tap releases before the hold fires.
  let holdTimer = null;
  let armedSpan = null;
  let pressSpan = null;
  let holdFired = false;

  let tapSpan = null;
  let tapCount = 0;
  let tapTimer = null;

  const clearHold = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (armedSpan) {
      armedSpan.classList.remove('is-arming');
      armedSpan.style.removeProperty('--arm-ms');
      armedSpan = null;
    }
  };

  const resetTaps = () => {
    if (tapTimer) {
      clearTimeout(tapTimer);
      tapTimer = null;
    }
    tapCount = 0;
    tapSpan = null;
  };

  // The bubble shares the popup's word identity: a contraction glosses as its
  // decomposition ("didn't = did + not", instant); an ordinary word looks up its
  // lemma. ⋯ expands into the full popup; the chips mark via the same `apply` as
  // the popup buttons (all occurrences, contraction parts included).
  const showGlossFor = (span) => {
    const surface = span.textContent;
    const sentence = getSentence(Number(span.dataset.i));
    const parts = span.dataset.parts ? span.dataset.parts.split(' ') : null;
    const word = parts ? normalizeSurface(surface) : span.dataset.word;
    showGloss(span, {
      surface,
      word,
      sentence,
      parts,
      onExpand: () => openPopup(span),
      onMark: (state) => apply(span, state),
    });
  };

  // Act on a finished tap sequence: 1 = word bubble (unknown/learning only — a
  // known word must not interrupt reading), 2 = paragraph bubble.
  const resolveTaps = () => {
    const span = tapSpan;
    const count = tapCount;
    resetTaps();
    if (!span) return;
    if (count >= 2) {
      const wordIndex = Number(span.dataset.i);
      showParagraphActions(span, {
        surface: span.textContent,
        paragraph: getParagraph(wordIndex),
        wordIndex,
        getParagraphSpeech,
        followWord,
      });
    } else if (span.dataset.state !== 'known' && span.dataset.state !== 'discarded') {
      // Known and discarded are "resolved": a single tap never interrupts reading.
      // (A deliberate hold still opens the bubble to reverse a wrong discard.)
      showGlossFor(span);
    }
  };

  const beginPress = (span) => {
    pressSpan = span;
    holdFired = false;
    if (tapSpan && tapSpan !== span) resetTaps(); // pressing a new word abandons the old sequence
    if (tapTimer) {
      clearTimeout(tapTimer); // pause single-tap resolution while the finger is down
      tapTimer = null;
    }
    const delay = OPEN_HOLD_MS[span.dataset.state] ?? OPEN_HOLD_MS.unknown;
    if (delay >= ARMING_MIN_MS) {
      armedSpan = span;
      span.style.setProperty('--arm-ms', `${delay}ms`);
      span.classList.add('is-arming'); // drives the fill animation
    }
    holdTimer = setTimeout(() => {
      holdFired = true;
      clearHold();
      resetTaps();
      showGlossFor(span); // the bubble first, always — the popup opens from its ⋯
    }, delay);
  };

  const endPress = () => {
    const span = pressSpan;
    pressSpan = null;
    clearHold();
    if (holdFired || !span) return; // the hold already opened it — not a tap
    if (tapSpan !== span) tapCount = 0;
    tapSpan = span;
    tapCount += 1;
    if (tapCount >= 2) {
      resolveTaps(); // double tap — act at once, nothing waits for a third
      return;
    }
    tapTimer = setTimeout(resolveTaps, MULTI_TAP_MS);
  };

  flow.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // primary button / touch only
    const span = e.target.closest('.word');
    if (!span || !flow.contains(span)) return;
    // Touch pointers implicitly capture to the pressed element, which would
    // retarget every later pointer event to the span no matter where the finger
    // actually is — the move-off cancel below would never fire and a hold could
    // open the popup under a finger that already wandered away. Release the
    // capture so touch follows real hit-testing, exactly like the mouse.
    if (e.target.hasPointerCapture?.(e.pointerId)) {
      e.target.releasePointerCapture(e.pointerId);
    }
    beginPress(span);
  });
  // Suppress the long-press context menu on words so it cannot interrupt a hold on
  // mobile (pairs with user-select/touch-callout: none in the CSS).
  flow.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.word')) e.preventDefault();
  });
  flow.addEventListener('pointerup', endPress);
  // A cancel (e.g. a scroll taking over on touch) drops the whole gesture.
  flow.addEventListener('pointercancel', () => {
    pressSpan = null;
    clearHold();
    resetTaps();
  });
  // Moving off the pressed word cancels THIS press (it won't count as a tap) but
  // leaves earlier taps to resolve on their own.
  flow.addEventListener('pointermove', (e) => {
    if (pressSpan && e.target.closest('.word') !== pressSpan) {
      pressSpan = null;
      clearHold();
    }
  });
  // A fast drag can exit the text column without any intermediate move landing
  // inside it — no pointermove/pointerup would reach `flow` and the hold would
  // stay armed. Leaving the column cancels the press. Taps are left alone: on
  // touch, lifting the finger between the taps of a double tap also leaves.
  flow.addEventListener('pointerleave', () => {
    pressSpan = null;
    clearHold();
  });

  // Links (URL/e-mail tokens, see tokenizer.js): a tap opens the LINK BUBBLE with
  // visible Open / Copy buttons — same rule as everything else, tapping never
  // navigates by itself. Links have no hold / double-tap semantics, so a plain
  // click (which never fires when the hold gesture consumed the press on a word)
  // is enough.
  flow.addEventListener('click', (e) => {
    const link = e.target.closest('.link');
    if (link && flow.contains(link)) showLinkActions(link, { url: link.textContent });
  });

  flow.addEventListener('keydown', (e) => {
    const link = e.target.closest('.link');
    if (link && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      showLinkActions(link, { url: link.textContent });
      return;
    }
    const span = e.target.closest('.word');
    if (!span) return;
    const state = KEY_TO_STATE[e.key];
    if (state) {
      e.preventDefault();
      apply(span, state);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPopup(span);
    }
  });
}
