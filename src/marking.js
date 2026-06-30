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

  // Set up the AI (Ollama) panel. The AI is NEVER auto-queried — for every word
  // state it waits for the user's explicit request. We show any already-cached
  // contexts immediately (no LLM call) and, when the AI is reachable, offer a
  // button to look up the CURRENT context. `surface` is the original surface form
  // sent to the AI (so it sees "Dursley's" / "didn't", not the stripped key).
  const setupAi = (word, surface, sentence, active) => {
    popup.setAiList(getAiList(word), sentence); // cached contexts only, no lookup

    const ask = () => {
      popup.setAiList(getAiList(word), sentence, true); // "Looking up IA…" row
      getAiDefinition(surface, sentence)
        .then((def) => {
          if (!active()) return;
          if (def) pushAi(word, sentence, def);
          // A null answer (timeout / error / empty reply) must not vanish silently:
          // surface an error row so the user knows the lookup failed, not that it
          // is still working.
          popup.setAiList(getAiList(word), sentence, false, !def);
          popup.showAiButton('↻ Ask AI again (this context)', ask);
        })
        .catch(() => {
          if (!active()) return;
          popup.setAiList(getAiList(word), sentence, false, true);
          popup.showAiButton('↻ Ask AI again (this context)', ask);
        });
    };

    const label = getAiForSentence(word, sentence)
      ? '↻ Ask AI again (this context)'
      : 'Ask AI (this context)';
    isAiAvailable().then((ok) => {
      if (ok && active()) popup.showAiButton(label, ask);
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
        popup.setQuick(fresh);
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
      popup.setQuick(cached);
      buildInBackground(word, cached, sentence, active);
      return;
    }

    if (cached) popup.setQuick(cached); // KB cache: show instantly, then revalidate
    else popup.quickLoading();

    getQuickDefinition(word, sentence)
      .then((def) => {
        if (!active()) return;
        if (def) {
          cacheDictionary(word, def);
          popup.setQuick(def);
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

    // The AI is always on demand (user request) for EVERY state — show cached
    // contexts now and, when reachable, a button to look up the current one.
    setupAi(word, surface, sentence, active);

    if (state === 'known') {
      // Known: never auto-fetch the dictionary either. Offer a button to look it
      // up if the user wants (instant from cache). State is NOT changed.
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
