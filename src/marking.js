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
} from './definitions/index.js';
import {
  getContraction,
  isUnknownContraction,
  learnContraction,
  aggregateStates as aggregateContraction,
} from './contractions.js';
import { getLanguage } from './settings.js';
import {
  getCached,
  cacheDictionary,
  getAiList,
  getAiForSentence,
  pushAi,
  getCachedLang,
  cacheLang,
} from './definitionsCache.js';

const KEY_TO_STATE = { 1: 'known', 2: 'learning', 3: 'unknown' };

/**
 * @param {HTMLElement} flow the rendered content (delegation root)
 * @param {{ getSentence?: (wordIndex: number) => string }} [opts]
 */
export function attachMarking(flow, { getSentence = () => '' } = {}) {
  const popup = new WordPopup();

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

  let requestId = 0;

  // Ask the AI for a context. `word` is the normalized vocabulary key (used for
  // caching); `surface` is the original surface form sent to the AI so it sees
  // "Dursley's" or "didn't" rather than the stripped/lowercased key.
  const askAi = (word, surface, sentence, active) => {
    // Current context already answered (cached): just show it.
    if (getAiForSentence(word, sentence)) {
      popup.setAiList(getAiList(word), sentence);
      return;
    }
    popup.setAiList(getAiList(word), sentence, true);
    getAiDefinition(surface, sentence)
      .then((def) => {
        if (!active()) return;
        if (def) pushAi(word, sentence, def);
        popup.setAiList(getAiList(word), sentence);
      })
      .catch(() => active() && popup.setAiList(getAiList(word), sentence));
  };

  // Load dictionary + AI for a word, cache-first.
  const loadDefinitions = (word, surface, sentence, active) => {
    const cached = getCached(word);

    // Dictionary: use normalized key (dictionaries index by base form).
    if (cached?.dictionary) {
      popup.setQuick(cached.dictionary);
    } else {
      popup.quickLoading();
      getQuickDefinition(word, sentence)
        .then((def) => {
          if (!active()) return;
          if (def) {
            cacheDictionary(word, def);
            popup.setQuick(def);
          } else {
            popup.setQuickLinks(word);
          }
        })
        .catch(() => active() && popup.setQuickLinks(word));
    }

    askAi(word, surface, sentence, active);
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
    const surface = span.textContent;      // original surface form for AI prompts
    const state = span.dataset.state;
    const sentence = getSentence(Number(span.dataset.i));
    const isContraction = !!span.dataset.parts;
    // Cache key: ordinary words use their lemma; contractions use their surface
    // (they have no lemma of their own), so cache/AI history is per contraction.
    const word = isContraction ? normalizeSurface(surface) : span.dataset.word;
    popup.show(span, state, (newState) => apply(span, newState));

    const myRequest = ++requestId;
    const active = () => myRequest === requestId && popup.visible;

    if (isContraction) showBreakdown(span);

    // On-demand native-language rescue — only offered when the AI is reachable
    // (it relies on Ollama) or we already have a cached answer for this context.
    const language = getLanguage();
    const showLang = () =>
      popup.showLangButton(`Explain in ${language}`, () => {
        const cachedLang = getCachedLang(word, language, sentence);
        if (cachedLang) {
          popup.setLang(cachedLang);
          return;
        }
        popup.langLoading(`Explaining in ${language}…`);
        getAiDefinitionInLanguage(surface, sentence, language)
          .then((def) => {
            if (!active()) return;
            if (def) cacheLang(word, language, sentence, def);
            popup.setLang(def);
          })
          .catch(() => active() && popup.setLang(null));
      });

    if (getCachedLang(word, language, sentence)) {
      showLang(); // cached -> works offline, always offer it
    } else {
      isAiAvailable().then((ok) => {
        if (ok && active()) showLang();
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

    if (state === 'known') {
      // Known: never auto-fetch. Offer a button to look it up if the user wants
      // (shows from cache instantly if available). State is NOT changed.
      popup.showLookupButton(() => {
        popup.hideLookupButton();
        loadDefinitions(word, surface, sentence, active);
      });
      return;
    }

    // Learning / Unknown: show definitions automatically (cache-first).
    loadDefinitions(word, surface, sentence, active);
  };

  flow.addEventListener('click', (e) => {
    const span = e.target.closest('.word');
    if (!span || !flow.contains(span)) return;
    openPopup(span);
  });

  flow.addEventListener('keydown', (e) => {
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
