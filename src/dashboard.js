// Vocabulary dashboard: a Stats tab (counts + growth chart) and a Dictionary tab
// (browse marked words with their cached dictionary + AI explanations).

import { listEntries, setState, STATES, normalize, getState, usedLanguages } from './vocabulary.js';
import { summary, growthSeries, recent } from './stats.js';
import { growthChart, splitDonut } from './charts.js';
import { getCached, cacheDictionary } from './definitionsCache.js';
import { getQuickDefinition, listKbWords, getKbStats } from './definitions/index.js';
import { renderKbDetails } from './kbDetails.js';
import { buildExternalLinks } from './externalLookup.js';
import { speakerButton } from './speech.js';
import { listBooks, getBookWords, setBookWords, getBookContent } from './library.js';
import { bookWordData } from './deck.js';
import {
  getReadingLang,
  setActiveReadingLang,
  getDefaultReadingLang,
  READING_LANGUAGES,
  readingLangName,
} from './settings.js';

const DICT_CHUNK = 25; // dictionary rows rendered per windowed chunk
const ROW_PX = 64; // height estimate per row (before measuring)

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Shared dictionary controls state, persisted across hub switches so search / sort
// (and the last filter) survive leaving and re-entering the Dictionary view.
const dictState = { search: '', filter: 'all', sort: 'recent' };

// The reading language the Progress / Dictionary hubs are scoped to. Vocabulary and
// definitions are keyed per language, so each language is its OWN dictionary and its
// OWN progress — never mixed. Defaults to the active reading language (the last book
// opened) and is changed in-UI via the language switcher, not via settings.
let dashLang = null;

function currentLang() {
  if (!dashLang) dashLang = getReadingLang();
  return dashLang;
}

/**
 * A small selector that switches which language's dictionary / progress is shown.
 * Lists every language that has marked words, plus the one currently in view. When
 * changed it re-aligns the whole stack (state writes, lookups, caching) by setting
 * the active reading language, then re-renders via `onChange`.
 * @param {(code: string) => void} onChange
 */
function langSwitcher(onChange) {
  const codes = new Set(usedLanguages());
  codes.add(currentLang()); // always offer the language being viewed
  const options = READING_LANGUAGES.filter((l) => codes.has(l.code));

  const wrap = document.createElement('label');
  wrap.className = 'dash-lang';

  const text = document.createElement('span');
  text.className = 'dash-lang__label';
  text.textContent = 'Language';

  const sel = document.createElement('select');
  sel.className = 'dash-lang__select';
  for (const { code } of options) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = readingLangName(code);
    sel.appendChild(opt);
  }
  sel.value = currentLang();
  sel.disabled = options.length <= 1; // nothing to switch between yet
  sel.addEventListener('change', () => onChange(sel.value));

  wrap.append(text, sel);
  return wrap;
}

/**
 * Progress hub: the user's learning at a glance (counts, growth, per-book).
 * @param {HTMLElement} root
 * @param {{ onOpenDictionary?: (filter: string) => void }} [opts]
 */
export function renderProgress(root, { onOpenDictionary } = {}) {
  root.replaceChildren();
  const lang = currentLang();
  setActiveReadingLang(lang); // keep getState/cache in renderPerBook aligned

  root.append(
    langSwitcher((code) => {
      dashLang = code;
      renderProgress(root, { onOpenDictionary });
    }),
  );

  const s = summary(lang);
  const r = recent(7, lang);

  const cards = document.createElement('div');
  cards.className = 'stat-cards';
  // Known / Learning are clickable: they deep-link into the Dictionary, pre-filtered.
  cards.append(
    statCard('Known', s.known, onOpenDictionary && (() => onOpenDictionary('known'))),
    statCard('Learning', s.learning, onOpenDictionary && (() => onOpenDictionary('learning'))),
    statCard('Total', s.total),
    statCard('This week', `+${r.known + r.learning}`),
  );
  // Discarded (exempt) words are not learned vocabulary, so they stay out of the
  // Total/donut; surface a card only once some exist, deep-linking to their filter.
  if (s.discarded) {
    cards.append(
      statCard('Discarded', s.discarded, onOpenDictionary && (() => onOpenDictionary('discarded'))),
    );
  }

  const split = document.createElement('div');
  split.className = 'stat-split';
  split.append(splitDonut(s.known, s.learning), legend());

  const chartWrap = document.createElement('div');
  chartWrap.className = 'stat-chart';
  const heading = document.createElement('div');
  heading.className = 'stat-chart__title';
  heading.textContent = 'Growth over time';
  const points = growthSeries(lang);
  chartWrap.append(heading);
  if (points.length) {
    chartWrap.append(growthChart(points));
  } else {
    const empty = document.createElement('p');
    empty.className = 'dash__empty';
    empty.textContent = 'Mark some words while reading to see your growth here.';
    chartWrap.append(empty);
  }

  const perBook = document.createElement('div');
  perBook.className = 'stat-perbook';
  perBook.innerHTML = '<div class="stat-chart__title">Per book</div>';
  root.append(cards, split, chartWrap, perBook);
  renderPerBook(perBook, lang);
}

// Per-book breakdown: how many of each book's unique words are known/learning/new.
// Scoped to `lang` so it only shows books written in the language being viewed.
async function renderPerBook(container, lang) {
  const prevLang = getReadingLang();
  const books = (await listBooks()).filter((b) => (b.lang || getDefaultReadingLang()) === lang);
  if (!books.length) {
    const empty = document.createElement('p');
    empty.className = 'dash__empty';
    empty.textContent = 'No books in this language yet.';
    container.appendChild(empty);
    return;
  }
  for (const book of books) {
    // Word states are language-scoped; every book here is already in `lang`.
    setActiveReadingLang(book.lang || getDefaultReadingLang());
    let words = await getBookWords(book.id);
    if (!words) {
      // Backfill for books added before per-book word data was stored (or when
      // its stored format is older than the current version).
      const content = await getBookContent(book.id);
      if (content?.text) {
        const data = bookWordData(content.text);
        words = data.words;
        setBookWords(book.id, data);
      }
    }
    const c = { known: 0, learning: 0, unknown: 0, discarded: 0 };
    for (const w of words || []) c[getState(w)] += 1;
    // Discarded words are exempt, so they leave the learnable denominator.
    const total = ((words || []).length - c.discarded) || 1;

    const row = document.createElement('div');
    row.className = 'perbook-row';
    row.innerHTML = `
      <div class="perbook-row__title">${escapeHtml(book.title)}</div>
      <div class="perbook-bar">
        <span style="flex:${c.known}" class="seg seg--known"></span>
        <span style="flex:${c.learning}" class="seg seg--learning"></span>
        <span style="flex:${c.unknown}" class="seg seg--unknown"></span>
      </div>
      <div class="perbook-row__nums">${c.known} known · ${c.learning} learning · ${c.unknown} new · ${total} total</div>`;
    container.appendChild(row);
  }
  setActiveReadingLang(prevLang); // restore the language in effect
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// A stat card. With an `onClick` it renders as a real <button> (focusable, keyboard
// accessible) that deep-links elsewhere; otherwise it's a plain, inert <div>.
// Compact "time ago" for the dictionary stats meta line.
function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// A stats card for the dictionary DATA (the KB): how many words have been built,
// how many carry synonyms/antonyms, recent activity, base size. Async — fetched
// from the KB /stats endpoint; degrades gracefully when the service is off.
function kbStatsCard(lang) {
  const card = document.createElement('section');
  card.className = 'kb-stats';
  const loading = document.createElement('p');
  loading.className = 'dash__empty';
  loading.textContent = 'Loading dictionary stats…';
  card.appendChild(loading);

  getKbStats(lang).then((s) => {
    card.replaceChildren();
    if (!s) {
      const msg = document.createElement('p');
      msg.className = 'dash__empty';
      msg.textContent = 'Dictionary service not reachable (start it with npm run server).';
      card.appendChild(msg);
      return;
    }
    const n = (x) => Number(x || 0).toLocaleString();

    const title = document.createElement('h3');
    title.className = 'kb-stats__title';
    title.textContent = 'Dictionary data';
    card.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'stat-cards';
    grid.append(
      statCard('Built words', n(s.refined)),
      statCard('With synonyms', n(s.withSynonyms)),
      statCard('With antonyms', n(s.withAntonyms)),
      statCard('Built this week', n(s.builtWeek)),
    );
    card.appendChild(grid);

    const models = (s.byModel || []).map((m) => `${m.model} (${n(m.count)})`).join(', ');
    const last = s.lastBuiltAt ? timeAgo(s.lastBuiltAt) : '—';
    const meta = document.createElement('p');
    meta.className = 'kb-stats__meta';
    meta.textContent = `Base: ${n(s.baseEntries)} KB entries · model: ${models || '—'} · last built ${last}`;
    card.appendChild(meta);

    if (s.recent?.length) {
      const recent = document.createElement('p');
      recent.className = 'kb-stats__recent';
      recent.append('Recent: ');
      s.recent.forEach((r, i) => {
        if (i) recent.append(' · ');
        const chip = document.createElement('span');
        chip.className = 'kb-chip';
        chip.textContent = r.word;
        if (r.definition) chip.title = r.definition;
        recent.appendChild(chip);
      });
      card.appendChild(recent);
    }
  });

  return card;
}

function statCard(label, value, onClick) {
  const card = document.createElement(onClick ? 'button' : 'div');
  card.className = 'stat-card';
  if (onClick) {
    card.type = 'button';
    card.classList.add('stat-card--btn');
    card.addEventListener('click', onClick);
  }
  card.innerHTML = `<span class="stat-card__value">${value}</span><span class="stat-card__label">${label}</span>`;
  return card;
}

function legend() {
  const el = document.createElement('div');
  el.className = 'stat-legend';
  el.innerHTML = `
    <span><i class="dot dot--known"></i> Known</span>
    <span><i class="dot dot--learning"></i> Learning</span>`;
  return el;
}

/**
 * Dictionary hub: browse marked words with their cached definitions.
 * @param {HTMLElement} root
 * @param {{ filter?: string }} [opts] When given, pre-selects a filter chip
 *   (used by the Progress stat-card deep-link).
 */
export function renderDictionary(root, { filter } = {}) {
  root.replaceChildren();
  if (filter) dictState.filter = filter;
  if (dictState._io) {
    dictState._io.disconnect();
    dictState._io = null;
  }
  const state = dictState;
  const scrollRoot = root;
  const lang = currentLang();
  setActiveReadingLang(lang); // state writes / lookups / caching target this language

  root.append(
    langSwitcher((code) => {
      dashLang = code;
      renderDictionary(root, {});
    }),
    kbStatsCard(lang),
  );

  const controls = document.createElement('div');
  controls.className = 'dict-controls';

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search words…';
  search.className = 'dict-search';
  search.value = state.search;

  // Sort toggle (Recent ⇆ A–Z) — same values the old <select> used.
  const sortToggle = document.createElement('button');
  sortToggle.type = 'button';
  sortToggle.className = 'dict-sort';
  const sortText = () => (state.sort === 'a-z' ? 'A–Z' : 'Recent');
  sortToggle.textContent = sortText();
  sortToggle.addEventListener('click', () => {
    state.sort = state.sort === 'a-z' ? 'recent' : 'a-z';
    sortToggle.textContent = sortText();
    renderList();
  });

  const top = document.createElement('div');
  top.className = 'dict-controls__top';
  top.append(search, sortToggle);

  // Filter chips (All / Known / Learning / Discarded / Built) replacing the old
  // <select>; the active one is filled. Seeded from state.filter so a deep-link
  // lands already filtered. "Discarded" browses the exempt words so a wrong mark
  // can be moved back to known/learning via each row's state selector.
  const chips = document.createElement('div');
  chips.className = 'dict-chips';
  const chipButtons = {};
  for (const f of ['all', 'known', 'learning', 'discarded', 'built']) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = f[0].toUpperCase() + f.slice(1);
    chip.addEventListener('click', () => {
      state.filter = f;
      updateChips();
      renderList();
    });
    chipButtons[f] = chip;
    chips.appendChild(chip);
  }
  function updateChips() {
    for (const [f, chip] of Object.entries(chipButtons)) {
      const on = f === state.filter;
      chip.classList.toggle('is-active', on);
      chip.setAttribute('aria-pressed', String(on));
    }
  }

  controls.append(top, chips);

  const list = document.createElement('div');
  list.className = 'dict-list';

  // Walk to another word (a form tapped inside a family card). The list is windowed
  // AND a word the user has never marked has no row at all — an unknown "aiming" is
  // not in the vocabulary store by design (the red sea keeps no entry). So the way
  // to always land on a word is the search that already exists: filter down to it,
  // scroll to the top, and let the row flash. A word with no row of its own arrives
  // as the "look it up" card instead, which is the right destination for it.
  const goToWord = (form) => {
    state.search = form;
    search.value = form;
    if (state.filter !== 'built') state.filter = 'all';
    state._flash = form;
    updateChips();
    renderList();
    scrollRoot.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Windowed list: chunk rows; render only those near the viewport, collapse the
  // rest to a measured-height spacer so memory stays bounded for huge dictionaries.
  // `rowFn(item, reRender, goToWord)` builds one row, so the same machinery serves
  // both the marked-vocabulary rows and the KB "Built" rows.
  const windowInto = (items, rowFn) => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const chunk = e.target;
          if (e.isIntersecting) renderChunk(chunk, renderList);
          else unloadChunk(chunk);
        }
      },
      { root: scrollRoot, rootMargin: '600px 0px' },
    );
    state._io = io;

    for (let i = 0; i < items.length; i += DICT_CHUNK) {
      const wrapper = document.createElement('div');
      wrapper.className = 'dict-chunk';
      wrapper._slice = items.slice(i, i + DICT_CHUNK);
      wrapper._rowFn = rowFn;
      wrapper.style.height = `${wrapper._slice.length * ROW_PX}px`;
      list.appendChild(wrapper);
      io.observe(wrapper);
    }
  };

  // "Built" filter: browse the words refined in the KB (the dictionary content),
  // not the user's marked vocabulary. Fetched from the KB service; the list grows
  // as words are built by reading or the batch builder.
  const renderBuilt = async () => {
    const loading = document.createElement('p');
    loading.className = 'dash__empty';
    loading.textContent = 'Loading dictionary…';
    list.appendChild(loading);

    const words = await listKbWords({ lang, q: state.search.trim(), sort: state.sort });
    if (state.filter !== 'built') return; // user switched away while loading
    list.replaceChildren();

    if (words === null) {
      const msg = document.createElement('p');
      msg.className = 'dash__empty';
      msg.textContent = 'Dictionary service not reachable. Start it (npm run server) to browse built words.';
      list.appendChild(msg);
      return;
    }
    if (!words.length) {
      const empty = document.createElement('p');
      empty.className = 'dash__empty';
      empty.textContent = 'No built words yet. Read or run the batch builder to grow the dictionary.';
      list.appendChild(empty);
      return;
    }
    windowInto(words, kbRow);
  };

  const renderList = () => {
    if (state._io) state._io.disconnect();
    list.replaceChildren();

    if (state.filter === 'built') {
      renderBuilt();
      return;
    }

    let items = listEntries(lang);
    if (state.filter !== 'all') items = items.filter((e) => e.state === state.filter);
    const q = state.search.trim().toLowerCase();
    if (q) items = items.filter((e) => e.word.includes(q));
    items.sort(state.sort === 'a-z' ? (a, b) => a.word.localeCompare(b.word) : (a, b) => b.at - a.at);

    // Search a word not in the list yet → offer to look it up.
    const key = normalize(q);
    if (key && !listEntries(lang).some((e) => e.word === key)) {
      list.appendChild(lookupCard(key, renderList));
    }

    if (!items.length && !key) {
      const empty = document.createElement('p');
      empty.className = 'dash__empty';
      empty.textContent = 'No words yet. Mark words while reading to build your dictionary.';
      list.appendChild(empty);
      return;
    }

    windowInto(items, dictRow);
  };

  function renderChunk(wrapper, reRender) {
    if (wrapper._rendered) return;
    const rowFn = wrapper._rowFn || dictRow;
    const frag = document.createDocumentFragment();
    for (const entry of wrapper._slice) frag.appendChild(rowFn(entry, reRender, goToWord));
    wrapper.replaceChildren(frag);
    wrapper.style.height = '';
    wrapper._rendered = true;
  }

  function unloadChunk(wrapper) {
    if (!wrapper._rendered) return;
    wrapper.style.height = `${wrapper.offsetHeight}px`;
    wrapper.replaceChildren();
    wrapper._rendered = false;
  }

  search.addEventListener('input', () => {
    state.search = search.value;
    renderList();
  });

  root.append(controls, list);
  updateChips();
  renderList();
}

// The row the user just walked to from a family card: flash it and bring it into
// view, so arriving somewhere never feels like the page merely changed.
function flashIfTarget(row, word) {
  if (dictState._flash !== word) return;
  dictState._flash = null;
  row.classList.add('is-target');
  requestAnimationFrame(() => row.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  setTimeout(() => row.classList.remove('is-target'), 1600);
}

function dictRow(entry, reRender, goToWord) {
  const row = document.createElement('div');
  row.className = 'dict-row';

  const head = document.createElement('div');
  head.className = 'dict-row__head';

  const word = document.createElement('span');
  word.className = 'dict-row__word word';
  word.dataset.state = entry.state;
  word.textContent = entry.word;

  const stateSel = document.createElement('select');
  stateSel.className = 'dict-row__state';
  for (const s of STATES) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s[0].toUpperCase() + s.slice(1);
    stateSel.appendChild(opt);
  }
  stateSel.value = entry.state;
  stateSel.addEventListener('change', () => {
    setState(entry.word, stateSel.value);
    reRender(); // word may now be unknown (dropped) or change filter membership
  });

  // Hearing the word is part of knowing it — pronounce it with the hub's language.
  const speak = speakerButton(entry.word, getReadingLang);
  head.append(word, ...(speak ? [speak] : []), stateSel);
  row.appendChild(head);

  flashIfTarget(row, entry.word);

  const cached = getCached(entry.word);
  const dict = cached?.dictionary?.explanation;
  const ai = Array.isArray(cached?.ai) ? cached.ai : [];

  if (dict) {
    const p = document.createElement('p');
    p.className = 'dict-row__def';
    p.textContent = dict;
    row.appendChild(p);
    const detailHost = document.createElement('div');
    const initial = renderKbDetails(cached?.dictionary?.kb, entry.word, { onForm: goToWord });
    if (initial) detailHost.appendChild(initial);
    row.appendChild(detailHost);

    // A cached KB definition can be stale (the word was rebuilt / re-refined with a
    // stronger model — or the KB learned to send data the cache predates, like the
    // word's family). Revalidate against the local KB and update in place. The
    // DEFINITION TEXT is not the test for staleness: it is the part most likely to
    // stay identical while everything around it changed.
    if (cached.dictionary.source === 'kb') {
      getQuickDefinition(entry.word, '').then((fresh) => {
        if (!fresh || JSON.stringify(fresh) === JSON.stringify(cached.dictionary)) return;
        cacheDictionary(entry.word, fresh);
        p.textContent = fresh.explanation;
        detailHost.replaceChildren();
        const refreshed = renderKbDetails(fresh.kb, entry.word, { onForm: goToWord });
        if (refreshed) detailHost.appendChild(refreshed);
      });
    }
  }
  for (const ctx of ai) {
    const block = document.createElement('div');
    block.className = 'dict-row__ai';
    const ex = document.createElement('p');
    ex.className = 'dict-row__def';
    ex.textContent = ctx.explanation;
    const sen = document.createElement('p');
    sen.className = 'dict-row__ctx';
    sen.textContent = `“${truncate(ctx.sentence || '', 80)}”`;
    block.append(ex, sen);
    row.appendChild(block);
  }
  if (!dict) {
    // No dictionary entry cached yet — let the user fetch it on demand.
    row.appendChild(lookupButton(entry.word, reRender));
  }
  if (!dict && ai.length === 0) {
    const none = document.createElement('p');
    none.className = 'dict-row__none';
    none.textContent = 'No saved AI explanation yet — open it while reading for that.';
    row.appendChild(none);
  }

  return row;
}

// A "Built" row: a word refined in the KB (the dictionary content, not the user's
// marked vocabulary). Collapsed it shows basic info — word, part of speech, the
// short definition; clicking the head toggles the full KB detail (verb tenses,
// synonyms, antonyms), fetched lazily via the provider chain (which hits the KB).
function kbRow(item, _reRender, goToWord) {
  const row = document.createElement('div');
  row.className = 'dict-row';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'dict-row__head dict-row__head--toggle';
  head.setAttribute('aria-expanded', 'false');

  const word = document.createElement('span');
  word.className = 'dict-row__word word';
  word.dataset.state = getState(item.word); // color by the user's learning state
  word.textContent = item.word;

  const pos = document.createElement('span');
  pos.className = 'dict-row__pos';
  pos.textContent = (item.pos || []).join(' · ');

  head.append(word, pos);
  // The head is itself a <button> (expand toggle), so the 🔊 lives beside it.
  const headRow = document.createElement('div');
  headRow.className = 'dict-row__headrow';
  const speak = speakerButton(item.word, getReadingLang);
  headRow.append(head, ...(speak ? [speak] : []));
  row.appendChild(headRow);

  const def = document.createElement('p');
  def.className = 'dict-row__def';
  def.textContent = item.definition;
  row.appendChild(def);

  const detail = document.createElement('div');
  detail.className = 'dict-row__detail';
  detail.hidden = true;
  row.appendChild(detail);

  flashIfTarget(row, item.word);

  let loaded = false;
  head.addEventListener('click', async () => {
    detail.hidden = !detail.hidden;
    head.setAttribute('aria-expanded', String(!detail.hidden));
    if (loaded || detail.hidden) return;
    loaded = true;
    const full = await getQuickDefinition(item.word, '');
    const d = renderKbDetails(full?.kb, item.word, { onForm: goToWord });
    if (d) detail.appendChild(d);
  });

  return row;
}

// Fetch a word's dictionary definition on demand and cache it.
async function fetchDictionary(word) {
  const def = await getQuickDefinition(word, '');
  if (def) cacheDictionary(word, def);
  return def;
}

function lookupButton(word, reRender) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dict-lookup-btn';
  btn.textContent = 'Look up in dictionary';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Looking up…';
    const def = await fetchDictionary(word);
    if (def) {
      reRender();
    } else {
      btn.replaceWith(notInDictionary(word));
    }
  });
  return btn;
}

function notInDictionary(word) {
  const wrap = document.createElement('p');
  wrap.className = 'dict-row__none';
  wrap.append('Not in the dictionary. Look it up: ');
  buildExternalLinks(word).forEach((item, i) => {
    if (i) wrap.append(' · ');
    const a = document.createElement('a');
    a.href = item.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = item.label;
    wrap.appendChild(a);
  });
  return wrap;
}

// A card for a searched word that isn't in the vocabulary yet: look it up and/or
// add it to the vocabulary.
function lookupCard(word, reRender) {
  const card = document.createElement('div');
  card.className = 'dict-row dict-row--new';

  const head = document.createElement('div');
  head.className = 'dict-row__head';
  const title = document.createElement('span');
  title.className = 'dict-row__word';
  title.textContent = word;
  head.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'dict-row__mark';
  for (const s of ['known', 'learning']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dict-mark-btn';
    b.dataset.state = s;
    b.textContent = `Mark ${s}`;
    b.addEventListener('click', () => {
      setState(word, s);
      reRender();
    });
    actions.appendChild(b);
  }
  head.appendChild(actions);
  card.appendChild(head);

  const result = getCached(word)?.dictionary?.explanation;
  if (result) {
    const p = document.createElement('p');
    p.className = 'dict-row__def';
    p.textContent = result;
    card.appendChild(p);
  } else {
    card.appendChild(lookupButton(word, reRender));
  }
  return card;
}
