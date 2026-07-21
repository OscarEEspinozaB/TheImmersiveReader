// Floating popup for setting a word's state and showing its explanation. It
// positions itself near the clicked word and reports the chosen state through a
// callback.

import { buildExternalLinks } from './externalLookup.js';
import { renderKbDetails } from './kbDetails.js';
import { getKbUrl, getReadingLang } from './settings.js';

// Listed in MARK_ORDER (see vocabulary.js): the word's current state is hidden at
// show() time, so only the other three buttons appear. Keys stay bound to their
// state (1/2/3/4 in marking.js) regardless of position; they live in each button's
// tooltip rather than its label to keep the list clean. Discarded is the exempt
// state — not learnable vocabulary (proper nouns, code, Roman numerals…), manual
// only, reversible from here or the Dictionary hub.
const STATE_LABELS = [
  { state: 'discarded', label: 'Discarded', key: '4' },
  { state: 'unknown', label: 'Unknown', key: '3' },
  { state: 'known', label: 'Known', key: '1' },
  { state: 'learning', label: 'Learning', key: '2' },
];

// Host[:port] of a URL, for a compact source label (e.g. "192.168.100.6:4321").
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Human-readable label for a definition's `source`, making it obvious whether the
// answer came from the LOCAL dictionary (the LAN KB) or an ONLINE service.
function sourceLabel(source) {
  if (!source) return '';
  if (source === 'kb') {
    const host = hostOf(getKbUrl());
    return host ? `Local dictionary · ${host}` : 'Local dictionary';
  }
  // freedictionaryapi.com is English Wiktionary: for a non-English book its answer
  // is a TRANSLATION into English, not a same-language definition — say so plainly.
  if (source === 'freedict') {
    return getReadingLang() === 'en'
      ? 'Online · freedictionaryapi.com'
      : 'English translation · freedictionaryapi.com';
  }
  if (source === 'translation') return 'Translation · freedictionaryapi.com';
  if (source === 'wiktionary') return `Online · ${getReadingLang()}.wiktionary.org`;
  if (source === 'contraction') return 'Contraction';
  if (source === 'local') return 'Local dictionary';
  if (source.startsWith('ollama')) return source.replace(/^ollama/, 'AI · Ollama');
  return source;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class WordPopup {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'popup';
    this.el.hidden = true;

    // Header: the word (colored by its current state) + a legend naming that state,
    // so the buttons below can omit it (only the other three are offered).
    this.head = document.createElement('div');
    this.head.className = 'popup__head';
    this.title = document.createElement('span');
    this.title.className = 'popup__word';
    this.stateTag = document.createElement('span');
    this.stateTag.className = 'popup__state-tag';
    this.head.append(this.title, this.stateTag);
    this.el.appendChild(this.head);

    // Contraction breakdown: shows "didn't = did + not" with each component's
    // current state as a colored chip. Hidden for ordinary words.
    this.breakdown = document.createElement('div');
    this.breakdown.className = 'popup__breakdown';
    this.breakdown.hidden = true;
    this.el.appendChild(this.breakdown);

    const buttons = document.createElement('div');
    buttons.className = 'popup__buttons';
    this._buttons = {};
    for (const { state, label, key } of STATE_LABELS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.state = state;
      btn.textContent = label;
      btn.title = `Mark as ${label} (key ${key})`;
      btn.addEventListener('click', () => this._choose(state));
      buttons.appendChild(btn);
      this._buttons[state] = btn;
    }
    this.el.appendChild(buttons);

    // Definition slots: fast dictionary, then AI (Ollama), then the on-demand
    // native-language rescue.
    this.definition = document.createElement('div');
    this.definition.className = 'popup__definition';
    this.definition.hidden = true;
    this.quickSlot = this._makeSlot();
    this.aiSlot = this._makeSlot();
    this.langSlot = this._makeSlot();
    this.definition.append(this.quickSlot, this.aiSlot, this.langSlot);
    this.el.appendChild(this.definition);

    // On-demand "Look it up" button — shown for KNOWN words, which never
    // auto-fetch (the user already knows them; this is just to refresh/peek).
    this.lookupButton = document.createElement('button');
    this.lookupButton.type = 'button';
    this.lookupButton.className = 'popup__lookup-btn';
    this.lookupButton.textContent = 'Look it up';
    this.lookupButton.hidden = true;
    this.lookupButton.addEventListener('click', () => {
      if (this._onLookup) this._onLookup();
    });
    this.el.appendChild(this.lookupButton);

    // Re-ask the AI for the CURRENT context (adds it to the front of the history).
    this.refreshAiButton = document.createElement('button');
    this.refreshAiButton.type = 'button';
    this.refreshAiButton.className = 'popup__refresh-btn';
    this.refreshAiButton.textContent = '↻ Ask AI again (this context)';
    this.refreshAiButton.hidden = true;
    this.refreshAiButton.addEventListener('click', () => {
      if (this._onRefreshAi) this._onRefreshAi();
    });
    this.el.appendChild(this.refreshAiButton);

    // On-demand "Explain in <language>" button (immersion-first: only on request).
    this.langButton = document.createElement('button');
    this.langButton.type = 'button';
    this.langButton.className = 'popup__lang-btn';
    this.langButton.hidden = true;
    this.langButton.addEventListener('click', () => {
      if (this._onExplain) this._onExplain();
    });
    this.el.appendChild(this.langButton);

    document.body.appendChild(this.el);

    this._onChoose = null;
    // Dismiss when clicking elsewhere.
    document.addEventListener('pointerdown', (e) => {
      if (!this.el.hidden && !this.el.contains(e.target) && e.target !== this._anchor) {
        this.hide();
      }
    });
  }

  /**
   * @param {HTMLElement} anchor the word span
   * @param {string} currentState
   * @param {(state: string) => void} onChoose
   */
  show(anchor, currentState, onChoose) {
    this._anchor = anchor;
    this._onChoose = onChoose;
    this.title.textContent = anchor.textContent;
    this.title.dataset.state = currentState; // color the word like the reader
    this.stateTag.textContent = currentState[0].toUpperCase() + currentState.slice(1);
    this.stateTag.dataset.state = currentState;
    this.breakdown.hidden = true;
    this.breakdown.textContent = '';
    for (const [state, btn] of Object.entries(this._buttons)) {
      // The current state is conveyed by the word's color + legend, never a button,
      // so only the other three are offered.
      btn.hidden = state === currentState;
    }

    this.definition.hidden = true;
    this._hideSlot(this.quickSlot);
    this._hideSlot(this.aiSlot);
    this._hideSlot(this.langSlot);
    this.langButton.hidden = true;
    this.lookupButton.hidden = true;
    this.refreshAiButton.hidden = true;
    this._onExplain = null;
    this._onLookup = null;
    this._onRefreshAi = null;
    this._onRerefine = null;
    this._onRegenAi = null;

    this.el.hidden = false;
    this._position(anchor);
  }

  /**
   * Register the "regenerate" actions for this word, all real LLM calls the reader
   * can trigger when an answer came out wrong:
   *  • `onRerefine()`  re-does the DICTIONARY entry (the refined KB definition);
   *  • `onRegenAi()`   re-does the AI EXPLANATION in the reading language;
   *  • `onRegenLang()` re-does the AI EXPLANATION in the reader's native language.
   * A ↻ appears next to each answer only when its handler is set here.
   */
  setRegenerators({ onRerefine = null, onRegenAi = null, onRegenLang = null } = {}) {
    this._onRerefine = onRerefine;
    this._onRegenAi = onRegenAi;
    this._onRegenLang = onRegenLang;
  }

  /**
   * Position the popup (fixed) near the word but always within the viewport: a
   * fixed width prevents the layout from collapsing near the right edge, and it
   * opens below or above the word depending on which side has more room, with a
   * capped height so its content scrolls instead of going off-screen.
   */
  _position(anchor) {
    const margin = 8;
    const gap = 6;
    const rect = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const width = this.el.offsetWidth;
    const left = Math.max(margin, Math.min(rect.left, vw - width - margin));
    this.el.style.left = `${left}px`;

    const spaceBelow = vh - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    if (spaceBelow >= spaceAbove) {
      this.el.style.top = `${rect.bottom + gap}px`;
      this.el.style.bottom = 'auto';
      this.el.style.maxHeight = `${spaceBelow - gap}px`;
    } else {
      this.el.style.top = 'auto';
      this.el.style.bottom = `${vh - rect.top + gap}px`;
      this.el.style.maxHeight = `${spaceAbove - gap}px`;
    }
  }

  /**
   * Show a contraction's decomposition: "didn't = did + not", each part a chip
   * colored by its current state. Marking the word (the buttons above) applies to
   * ALL parts at once. An optional note explains nuance (would/had, irregulars).
   * @param {string} surface e.g. "didn't"
   * @param {{ lemma: string, state: string }[]} components
   * @param {string} [note]
   */
  setBreakdown(surface, components, note) {
    this.breakdown.textContent = '';
    this.breakdown.hidden = false;

    const eq = document.createElement('div');
    eq.className = 'popup__breakdown-row';
    const head = document.createElement('span');
    head.className = 'popup__breakdown-eq';
    head.textContent = '=';
    eq.appendChild(head);
    components.forEach((c, i) => {
      if (i) {
        const plus = document.createElement('span');
        plus.className = 'popup__breakdown-plus';
        plus.textContent = '+';
        eq.appendChild(plus);
      }
      const chip = document.createElement('span');
      chip.className = 'popup__breakdown-chip word';
      chip.dataset.state = c.state;
      chip.textContent = c.lemma;
      eq.appendChild(chip);
    });
    this.breakdown.appendChild(eq);

    if (note) {
      const n = document.createElement('p');
      n.className = 'popup__breakdown-note';
      n.textContent = note;
      this.breakdown.appendChild(n);
    }
  }

  // --- Dictionary (quick) slot ---
  quickLoading() {
    this._fillSlot(this.quickSlot, { state: 'loading', text: 'Looking up…' });
  }

  /**
   * @param {import('./definitions/index.js').Definition | null} def
   * @param {string} [word] the normalized word looked up — marked as the current
   *   one inside its family card.
   */
  setQuick(def, word) {
    if (def) {
      // The ↻ is only for an AI-refined KB entry — a raw or online definition is
      // not the AI's to re-do (same rule as the Dictionary hub).
      const regen = def.source === 'kb' && def.refined && this._onRerefine ? () => this._onRerefine() : null;
      this._fillSlot(this.quickSlot, {
        state: 'ready', text: def.explanation, source: def.source, kb: def.kb, word, regen,
        pronunciation: def.pronunciation,
      });
    } else {
      this._hideSlot(this.quickSlot);
    }
  }

  /**
   * Render the AI usage panorama. The current context is always shown FIRST and
   * highlighted; the other contexts follow. When `loadingCurrent` is true, a
   * loading row is shown at the top while a fresh answer is generated — the
   * already-stored contexts remain visible below it.
   * @param {import('./definitionsCache.js').AiContext[]} items
   * @param {string} currentSentence
   * @param {boolean} [loadingCurrent]
   * @param {boolean} [errorCurrent]  the current lookup failed (timeout / error /
   *   empty reply); show an error row instead of silently hiding the panel
   */
  setAiList(items, currentSentence, loadingCurrent = false, errorCurrent = false) {
    const list = Array.isArray(items) ? items : [];
    const current = list.find((i) => i.sentence === currentSentence) || null;
    const others = list.filter((i) => i.sentence !== currentSentence);

    if (!loadingCurrent && !errorCurrent && !current && others.length === 0) {
      this._hideSlot(this.aiSlot);
      return;
    }

    const slot = this.aiSlot;
    slot.hidden = false;
    slot.dataset.state = 'ready';
    slot.textContent = '';

    // Current context first (loading, or its answer), then the rest.
    if (loadingCurrent) {
      const block = document.createElement('div');
      block.className = 'ai-item is-current is-loading';
      const text = document.createElement('p');
      text.className = 'ai-item__text';
      text.textContent = 'Looking up IA… (this context)';
      block.appendChild(text);
      slot.appendChild(block);
    } else if (current) {
      slot.appendChild(this._aiItem(current, true));
    } else if (errorCurrent) {
      const block = document.createElement('div');
      block.className = 'ai-item is-current is-error';
      const text = document.createElement('p');
      text.className = 'ai-item__text';
      text.textContent = 'Could not get an answer (is the AI reachable? it may be slow — try again).';
      block.appendChild(text);
      slot.appendChild(block);
    }
    for (const o of others) slot.appendChild(this._aiItem(o, false));

    const source = (current || others[0])?.source;
    if (source) {
      const el = document.createElement('span');
      el.className = 'popup__slot-source';
      el.textContent = sourceLabel(source);
      slot.appendChild(el);
    }
    this.definition.hidden = false;
  }

  _aiItem(item, isCurrent) {
    const block = document.createElement('div');
    block.className = isCurrent ? 'ai-item is-current' : 'ai-item';
    const text = document.createElement('p');
    text.className = 'ai-item__text';
    text.textContent = item.explanation;
    // Only the CURRENT context can be re-done (an old context's sentence is not on
    // screen to judge it against); the ↻ shares the text's row.
    if (isCurrent && this._onRegenAi) {
      const row = document.createElement('div');
      row.className = 'popup__slot-row';
      row.append(text, this._regenButton('Re-do this explanation with the AI', () => this._onRegenAi()));
      block.appendChild(row);
    } else {
      block.appendChild(text);
    }
    const ctx = document.createElement('p');
    ctx.className = 'ai-item__context';
    ctx.textContent = `“${truncate(item.sentence, 70)}”`;
    block.appendChild(ctx);
    return block;
  }

  /**
   * Show the on-demand AI button. The AI (Ollama) is never auto-queried — the
   * user asks for the current context explicitly, for every word state.
   * @param {string} label e.g. "Ask AI (this context)"
   * @param {() => void} onAsk
   */
  showAiButton(label, onAsk) {
    this.refreshAiButton.textContent = label;
    this.refreshAiButton.hidden = false;
    this._onRefreshAi = onAsk;
  }

  hideAiButton() {
    this.refreshAiButton.hidden = true;
  }

  // --- On-demand "look it up" (known words) ---
  /** @param {() => void} onLookup */
  showLookupButton(onLookup) {
    this.lookupButton.hidden = false;
    this._onLookup = onLookup;
  }

  hideLookupButton() {
    this.lookupButton.hidden = true;
  }

  // --- On-demand native-language rescue ---
  /**
   * @param {string} label e.g. "Explain in Spanish"
   * @param {() => void} onExplain
   */
  showLangButton(label, onExplain) {
    this.langButton.textContent = label;
    this.langButton.hidden = false;
    this._onExplain = onExplain;
  }

  langLoading(text) {
    this.langButton.hidden = true;
    this._fillSlot(this.langSlot, { state: 'loading', text });
  }

  /** @param {import('./definitions/index.js').Definition | null} def */
  setLang(def) {
    if (def)
      this._fillSlot(this.langSlot, {
        state: 'ready',
        text: def.explanation,
        source: def.source,
        // Like the reading-language answer, the native explanation is AI-produced, so
        // it carries a ↻ to re-run the model when the translation came out wrong.
        regen: this._onRegenLang ? () => this._onRegenLang() : null,
        regenTitle: 'Re-do this explanation with the AI',
      });
    else this._fillSlot(this.langSlot, { state: 'error', text: 'Could not get an explanation (is the AI reachable?).' });
  }

  /**
   * A plain dictionary TRANSLATION into the reader's language (freedictionaryapi),
   * the away-from-home path when the AI is unreachable. Unlike setLang it carries no
   * ↻ — there is no model to re-run, it is a fixed dictionary lookup.
   * @param {import('./definitions/index.js').Definition | null} def
   */
  setLangTranslation(def) {
    if (def) this._fillSlot(this.langSlot, { state: 'ready', text: def.explanation, source: def.source });
    else this._hideSlot(this.langSlot);
  }

  /**
   * Shown whenever the dictionary has no entry (regardless of the AI result):
   * the AI is only a helper, so we always offer authoritative web dictionaries.
   * @param {string} word
   */
  setQuickLinks(word) {
    const slot = this.quickSlot;
    slot.hidden = false;
    slot.dataset.state = 'error';
    slot.textContent = '';

    const message = document.createElement('p');
    message.className = 'popup__slot-text';
    message.textContent = 'Not in the dictionary. Look it up:';
    slot.appendChild(message);

    const links = document.createElement('p');
    links.className = 'popup__links';
    buildExternalLinks(word).forEach((item, i) => {
      if (i) links.append(' · ');
      const a = document.createElement('a');
      a.href = item.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = item.label;
      links.appendChild(a);
    });
    slot.appendChild(links);

    this.definition.hidden = false;
  }

  _makeSlot() {
    const slot = document.createElement('div');
    slot.className = 'popup__slot';
    slot.hidden = true;
    return slot;
  }

  // A ↻ button that runs `onClick` (a real LLM call), spinning while it works. The
  // popup may be dismissed and reused mid-call, so `onClick` is responsible for
  // ignoring a stale result — the button only manages its own visual state.
  _regenButton(title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'popup__regen';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    // The ↻ lives in its own span so the spin rotates the glyph, not the button box.
    const icon = document.createElement('span');
    icon.className = 'regen-icon';
    icon.textContent = '↻';
    btn.appendChild(icon);
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.classList.add('is-working');
      try {
        await onClick();
      } finally {
        btn.disabled = false;
        btn.classList.remove('is-working');
      }
    });
    return btn;
  }

  _fillSlot(slot, { state, text, source, kb, word, regen, pronunciation, regenTitle = 'Re-do this definition with the AI' }) {
    slot.hidden = false;
    slot.dataset.state = state;
    slot.textContent = '';
    const p = document.createElement('p');
    p.className = 'popup__slot-text';
    p.textContent = text;
    // The definition and its "re-do with AI" button share a row, so the ↻ sits
    // beside the text it regenerates rather than floating below the whole slot.
    if (regen) {
      const row = document.createElement('div');
      row.className = 'popup__slot-row';
      row.append(p, this._regenButton(regenTitle, regen));
      slot.appendChild(row);
    } else {
      slot.appendChild(p);
    }
    if (pronunciation) {
      const ipa = document.createElement('span');
      ipa.className = 'popup__slot-ipa';
      ipa.textContent = pronunciation;
      slot.appendChild(ipa);
    }
    const details = renderKbDetails(kb, word);
    if (details) slot.appendChild(details);
    if (source) {
      const s = document.createElement('span');
      s.className = 'popup__slot-source';
      s.textContent = sourceLabel(source);
      slot.appendChild(s);
    }
    this.definition.hidden = false;
  }

  _hideSlot(slot) {
    slot.hidden = true;
    slot.textContent = '';
    if (this.quickSlot?.hidden && this.aiSlot?.hidden && this.langSlot?.hidden) {
      this.definition.hidden = true;
    }
  }

  hide() {
    this.el.hidden = true;
    this._anchor = null;
    this._onChoose = null;
  }

  get visible() {
    return !this.el.hidden;
  }

  _choose(state) {
    if (this._onChoose) this._onChoose(state);
    this.hide();
  }
}
