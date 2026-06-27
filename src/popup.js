// Floating popup for setting a word's state and showing its explanation. It
// positions itself near the clicked word and reports the chosen state through a
// callback.

import { buildExternalLinks } from './externalLookup.js';
import { renderKbDetails } from './kbDetails.js';
import { getKbUrl } from './settings.js';

const STATE_LABELS = [
  { state: 'known', label: 'Known', key: '1' },
  { state: 'learning', label: 'Learning', key: '2' },
  { state: 'unknown', label: 'Unknown', key: '3' },
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
  if (source === 'dictionary') return 'Online · dictionaryapi.dev';
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

    this.title = document.createElement('div');
    this.title.className = 'popup__word';
    this.el.appendChild(this.title);

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
      btn.textContent = `${label} (${key})`;
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
    this.breakdown.hidden = true;
    this.breakdown.textContent = '';
    for (const [state, btn] of Object.entries(this._buttons)) {
      btn.setAttribute('aria-current', String(state === currentState));
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

    this.el.hidden = false;
    this._position(anchor);
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

  /** @param {import('./definitions/index.js').Definition | null} def */
  setQuick(def) {
    if (def) this._fillSlot(this.quickSlot, { state: 'ready', text: def.explanation, source: def.source, kb: def.kb });
    else this._hideSlot(this.quickSlot);
  }

  /**
   * Render the AI usage panorama. The current context is always shown FIRST and
   * highlighted; the other contexts follow. When `loadingCurrent` is true, a
   * loading row is shown at the top while a fresh answer is generated — the
   * already-stored contexts remain visible below it.
   * @param {import('./definitionsCache.js').AiContext[]} items
   * @param {string} currentSentence
   * @param {boolean} [loadingCurrent]
   */
  setAiList(items, currentSentence, loadingCurrent = false) {
    const list = Array.isArray(items) ? items : [];
    const current = list.find((i) => i.sentence === currentSentence) || null;
    const others = list.filter((i) => i.sentence !== currentSentence);

    if (!loadingCurrent && !current && others.length === 0) {
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
    block.appendChild(text);
    const ctx = document.createElement('p');
    ctx.className = 'ai-item__context';
    ctx.textContent = `“${truncate(item.sentence, 70)}”`;
    block.appendChild(ctx);
    return block;
  }

  showRefreshAiButton(onRefresh) {
    this.refreshAiButton.hidden = false;
    this._onRefreshAi = onRefresh;
  }

  hideRefreshAiButton() {
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
    if (def) this._fillSlot(this.langSlot, { state: 'ready', text: def.explanation, source: def.source });
    else this._fillSlot(this.langSlot, { state: 'error', text: 'Could not get an explanation (is the AI reachable?).' });
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

  _fillSlot(slot, { state, text, source, kb }) {
    slot.hidden = false;
    slot.dataset.state = state;
    slot.textContent = '';
    const p = document.createElement('p');
    p.className = 'popup__slot-text';
    p.textContent = text;
    slot.appendChild(p);
    const details = renderKbDetails(kb);
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
