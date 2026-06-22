// Marking: wire word interaction to vocabulary state changes.
//
// - Click a word -> popup to pick Known / Learning / Unknown.
// - Keys 1/2/3 set the state of the focused word directly.
// In every case we persist the new state and recolor ALL occurrences of that
// word (keyed by its normalized form), not just the one clicked.

import { setState } from './vocabulary.js';
import { recolorWord } from './reader/render.js';
import { WordPopup } from './popup.js';
import {
  getQuickDefinition,
  getAiDefinition,
  getAiDefinitionInLanguage,
  isAiAvailable,
} from './definitions/index.js';
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

  const apply = (word, state) => {
    setState(word, state);
    recolorWord(flow, word, state);
  };

  let requestId = 0;

  // Ask the AI for a context. The refresh button is offered ONLY on a cache hit
  // (a previously-seen context the user may want to update); after a fresh
  // generation it is redundant, so it stays hidden.
  const askAi = (word, sentence, active) => {
    // Current context already answered (cached): just show it. No regenerate
    // button — the answer for this specific context already exists.
    if (getAiForSentence(word, sentence)) {
      popup.setAiList(getAiList(word), sentence);
      return;
    }
    // Current context not answered yet: show what's already stored immediately,
    // with a loading row at the top for the current context; replace it (first)
    // when it arrives.
    popup.setAiList(getAiList(word), sentence, true);
    getAiDefinition(word, sentence)
      .then((def) => {
        if (!active()) return;
        if (def) pushAi(word, sentence, def);
        popup.setAiList(getAiList(word), sentence);
      })
      .catch(() => active() && popup.setAiList(getAiList(word), sentence));
  };

  // Load dictionary + AI for a word, cache-first.
  const loadDefinitions = (word, sentence, active) => {
    const cached = getCached(word);

    // Dictionary (source of truth): cached, else query; if none, offer web links.
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

    askAi(word, sentence, active);
  };

  const openPopup = (span) => {
    const word = span.dataset.word;
    const state = span.dataset.state;
    const sentence = getSentence(Number(span.dataset.i));
    popup.show(span, state, (newState) => apply(word, newState));

    const myRequest = ++requestId;
    const active = () => myRequest === requestId && popup.visible;

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
        getAiDefinitionInLanguage(word, sentence, language)
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

    if (state === 'known') {
      // Known: never auto-fetch. Offer a button to look it up if the user wants
      // (shows from cache instantly if available). State is NOT changed.
      popup.showLookupButton(() => {
        popup.hideLookupButton();
        loadDefinitions(word, sentence, active);
      });
      return;
    }

    // Learning / Unknown: show definitions automatically (cache-first).
    loadDefinitions(word, sentence, active);
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
      apply(span.dataset.word, state);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPopup(span);
    }
  });
}
