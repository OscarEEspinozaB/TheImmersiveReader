// Vocabulary dashboard: a Stats tab (counts + growth chart) and a Dictionary tab
// (browse marked words with their cached dictionary + AI explanations).

import { listEntries, setState, STATES, normalize } from './vocabulary.js';
import { summary, growthSeries, recent } from './stats.js';
import { growthChart, splitDonut } from './charts.js';
import { getCached, cacheDictionary } from './definitionsCache.js';
import { getQuickDefinition } from './definitions/index.js';
import { buildExternalLinks } from './externalLookup.js';

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * @param {HTMLElement} root
 * @param {{ onBack: () => void }} opts
 */
export function renderDashboard(root, { onBack }) {
  root.replaceChildren();
  const state = { tab: 'stats', search: '', filter: 'all', sort: 'recent' };

  const bar = document.createElement('header');
  bar.className = 'dash__bar';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'menu-toggle';
  back.title = 'Back to library';
  back.innerHTML =
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
  back.addEventListener('click', onBack);

  const tabs = document.createElement('div');
  tabs.className = 'dash__tabs';
  const tabButtons = {};
  for (const [id, label] of [['stats', 'Stats'], ['dictionary', 'Dictionary']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dash__tab';
    b.textContent = label;
    b.addEventListener('click', () => {
      state.tab = id;
      updateTabs();
      renderBody();
    });
    tabButtons[id] = b;
    tabs.appendChild(b);
  }

  bar.append(back, tabs);
  const body = document.createElement('div');
  body.className = 'dash__body';
  root.append(bar, body);

  function updateTabs() {
    for (const [id, b] of Object.entries(tabButtons)) {
      b.classList.toggle('is-active', id === state.tab);
    }
  }

  function renderBody() {
    body.replaceChildren();
    if (state.tab === 'stats') renderStats(body);
    else renderDictionary(body, state);
  }

  updateTabs();
  renderBody();
}

function renderStats(body) {
  const s = summary();
  const r = recent(7);

  const cards = document.createElement('div');
  cards.className = 'stat-cards';
  cards.append(
    statCard('Known', s.known),
    statCard('Learning', s.learning),
    statCard('Total', s.total),
    statCard('This week', `+${r.known + r.learning}`),
  );

  const split = document.createElement('div');
  split.className = 'stat-split';
  split.append(splitDonut(s.known, s.learning), legend());

  const chartWrap = document.createElement('div');
  chartWrap.className = 'stat-chart';
  const heading = document.createElement('div');
  heading.className = 'stat-chart__title';
  heading.textContent = 'Growth over time';
  const points = growthSeries();
  chartWrap.append(heading);
  if (points.length) {
    chartWrap.append(growthChart(points));
  } else {
    const empty = document.createElement('p');
    empty.className = 'dash__empty';
    empty.textContent = 'Mark some words while reading to see your growth here.';
    chartWrap.append(empty);
  }

  body.append(cards, split, chartWrap);
}

function statCard(label, value) {
  const card = document.createElement('div');
  card.className = 'stat-card';
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

function renderDictionary(body, state) {
  const controls = document.createElement('div');
  controls.className = 'dict-controls';

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search words…';
  search.className = 'dict-search';
  search.value = state.search;

  const filter = select(['all', 'known', 'learning'], state.filter);
  const sort = select(['recent', 'a-z'], state.sort);

  controls.append(search, filter, sort);

  const list = document.createElement('div');
  list.className = 'dict-list';

  const renderList = () => {
    list.replaceChildren();
    let items = listEntries();
    if (state.filter !== 'all') items = items.filter((e) => e.state === state.filter);
    const q = state.search.trim().toLowerCase();
    if (q) items = items.filter((e) => e.word.includes(q));
    items.sort(state.sort === 'a-z' ? (a, b) => a.word.localeCompare(b.word) : (a, b) => b.at - a.at);

    // If searching a word that isn't in the list yet, offer to look it up.
    const key = normalize(q);
    if (key && !listEntries().some((e) => e.word === key)) {
      list.appendChild(lookupCard(key, renderList));
    }

    if (!items.length && !key) {
      const empty = document.createElement('p');
      empty.className = 'dash__empty';
      empty.textContent = 'No words yet. Mark words while reading to build your dictionary.';
      list.appendChild(empty);
      return;
    }
    for (const entry of items) list.appendChild(dictRow(entry, renderList));
  };

  search.addEventListener('input', () => {
    state.search = search.value;
    renderList();
  });
  filter.addEventListener('change', () => {
    state.filter = filter.value;
    renderList();
  });
  sort.addEventListener('change', () => {
    state.sort = sort.value;
    renderList();
  });

  body.append(controls, list);
  renderList();
}

function select(values, current) {
  const el = document.createElement('select');
  el.className = 'dict-select';
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v[0].toUpperCase() + v.slice(1);
    el.appendChild(opt);
  }
  el.value = current;
  return el;
}

function dictRow(entry, reRender) {
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

  head.append(word, stateSel);
  row.appendChild(head);

  const cached = getCached(entry.word);
  const dict = cached?.dictionary?.explanation;
  const ai = Array.isArray(cached?.ai) ? cached.ai : [];

  if (dict) {
    const p = document.createElement('p');
    p.className = 'dict-row__def';
    p.textContent = dict;
    row.appendChild(p);
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
