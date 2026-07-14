// Render the rich linguistic data from a local-KB definition (the `kb` payload
// attached by definitions/kbApi.js) into DOM: the word's FAMILY, its part of
// speech, synonyms and antonyms. Shared by the reader popup and the Dictionary tab
// so both surfaces show the same detail instead of just the first definition line.
//
// The family is the centrepiece: "gone" is not a loose red word, it is the past
// participle of GO, and the card shows the whole paradigm with every form painted
// in the state IT actually has — so the learner sees at a glance that they already
// know `go` and `goes` but have never met `gone`.
//
// It shows; it never marks. Each form still has to be met and marked on its own
// (the red-sea invariant): nothing here changes a word's state, and knowing "go"
// says nothing about "went".

import { getState } from './vocabulary.js';

// Expand the terse part-of-speech codes the dataset uses into readable words.
const POS_LABELS = {
  adj: 'adjective',
  adv: 'adverb',
  prep: 'preposition',
  conj: 'conjunction',
  det: 'determiner',
  num: 'numeral',
  intj: 'interjection',
  pron: 'pronoun',
  art: 'article',
  name: 'proper noun',
  character: 'letter',
};

// Wiktionary has an entry for almost any word AS A NAME (a surname, a brand, a
// letter of the alphabet), and the dump merges it into the word's POS list — which
// is how a common verb ends up announcing itself as "name · noun · verb". True but
// useless: when a word has a real part of speech, the incidental one is dropped.
const INCIDENTAL_POS = new Set(['name', 'character']);

function usefulPos(pos) {
  const real = pos.filter((p) => !INCIDENTAL_POS.has(p));
  return real.length ? real : pos; // a word that is ONLY a name still says so
}

/**
 * The word's parts of speech as one readable line ("noun · verb"), free of the
 * dump's incidental entries. Empty string when there is nothing to say.
 * @param {string[]} [pos]
 */
export function posSummary(pos) {
  return usefulPos(pos || []).map(posLabel).join(' · ');
}

// Order the verb-tense tags the way a learner reads them, regardless of dump order.
const TENSE_ORDER = ['past', 'past participle', 'present participle', 'third-person singular'];

// Readable phrasing for "<word> is the <tag> of <lemma>".
const FORM_LABELS = {
  past: 'Past tense',
  'past participle': 'Past participle',
  'present participle': 'Present participle',
  'third-person singular': 'Third-person singular',
  'first-person singular': 'First person',
  present: 'Present',
  'past plural': 'Past plural',
  plural: 'Plural',
  comparative: 'Comparative',
  superlative: 'Superlative',
  objective: 'Object form',
  'possessive determiner': 'Possessive',
  'possessive pronoun': 'Possessive',
  reflexive: 'Reflexive',
  'plural reflexive': 'Reflexive plural',
};

// The same tags, shortened to sit under a form chip in the family card.
const SHORT_TAGS = {
  base: 'base',
  past: 'past',
  'past participle': 'participle',
  'present participle': '-ing',
  'third-person singular': 'he/she/it',
  'first-person singular': 'I',
  present: 'you/we/they',
  'past plural': 'past pl.',
  plural: 'plural',
  comparative: 'more',
  superlative: 'most',
  objective: 'object',
  'possessive determiner': 'my-',
  'possessive pronoun': 'mine-',
  reflexive: '-self',
  'plural reflexive': '-selves',
};

function formOfLabel(tags) {
  const labels = (tags || []).map((t) => FORM_LABELS[t] || t);
  return labels.length ? labels.join(' / ') : 'Form';
}

function posLabel(pos) {
  return POS_LABELS[pos] || pos;
}

// Group inflections [{ tag, form }] into Map<tag, form[]>, deduped, in TENSE_ORDER.
function groupTenses(inflections) {
  const byTag = new Map();
  for (const { tag, form } of inflections) {
    if (!tag || !form) continue;
    if (!byTag.has(tag)) byTag.set(tag, []);
    const forms = byTag.get(tag);
    if (!forms.includes(form)) forms.push(form);
  }
  const ordered = [];
  for (const tag of TENSE_ORDER) if (byTag.has(tag)) ordered.push([tag, byTag.get(tag)]);
  for (const [tag, forms] of byTag) if (!TENSE_ORDER.includes(tag)) ordered.push([tag, forms]);
  return ordered;
}

/**
 * The family card: "PAST TENSE OF GO" + the whole paradigm, each form colored by
 * its own learning state, the form you are reading marked as current.
 *
 * Pronouns are shown but never scored: I/me/my/mine are four things a learner has
 * to learn, not "4/5 of one word" — grouping them helps (it is one system of
 * cases), rolling them into a fraction would flatter the count.
 *
 * @param {import('./definitionsCache.js').Family} family
 * @param {string} [current] the normalized word being looked up
 * @returns {HTMLElement}
 */
function familyCard(family, current, onForm, canGo) {
  const wrap = document.createElement('div');
  wrap.className = 'kb-family';

  if (family.tag) {
    const banner = document.createElement('div');
    banner.className = 'kb-row kb-formof';
    banner.append(`${formOfLabel([family.tag])} of `);
    const lemma = document.createElement('b');
    lemma.textContent = family.lemma;
    banner.append(lemma, ` · ${posLabel(family.pos)}`);
    wrap.appendChild(banner);
  }

  const forms = document.createElement('div');
  forms.className = 'kb-forms';
  let known = 0;
  let scored = 0;
  for (const { form, tags } of family.forms) {
    const state = getState(form);
    // Discarded forms are exempt everywhere else, so they don't drag the family
    // down here either — they leave the count instead of failing it.
    if (state !== 'discarded') {
      scored += 1;
      if (state === 'known') known += 1;
    }

    // Where the surface offers somewhere to GO (the Dictionary hub, the Word
    // Swiper), a form is a button that takes you to that word — a family you can
    // walk through, not a picture of one. It navigates; it never marks.
    const navigable = typeof onForm === 'function' && form !== current && (!canGo || canGo(form));
    const chip = document.createElement(navigable ? 'button' : 'span');
    chip.className = 'kb-form word';
    chip.dataset.state = state;
    if (form === current) chip.dataset.current = 'true';
    if (navigable) {
      chip.type = 'button';
      chip.title = `Go to “${form}”`;
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        onForm(form);
      });
    }

    const w = document.createElement('b');
    w.textContent = form;
    const tag = document.createElement('i');
    tag.textContent = tags.map((t) => SHORT_TAGS[t] || t).join(' · ');
    chip.append(w, tag);
    forms.appendChild(chip);
  }
  wrap.appendChild(forms);

  if (family.pos !== 'pron' && scored > 1) {
    const score = document.createElement('div');
    score.className = 'kb-family__score';
    score.textContent = `${known} of ${scored} forms known`;
    wrap.appendChild(score);
  }

  return wrap;
}

/**
 * The compact family strip for the word bubble: the same paradigm, colors only, no
 * tags — a glance at "which of these five do I already know" without leaving the
 * page. Null when there is no family to show.
 * @param {import('./definitionsCache.js').KbDetails} [kb]
 * @param {string} [current] the normalized word being looked up
 * @returns {HTMLElement | null}
 */
export function renderFamilyStrip(kb, current) {
  const family = kb?.family;
  if (!family || family.forms.length < 2) return null;

  const strip = document.createElement('div');
  strip.className = 'kb-forms kb-forms--strip';
  for (const { form } of family.forms) {
    const chip = document.createElement('span');
    chip.className = 'kb-form word';
    chip.dataset.state = getState(form);
    if (form === current) chip.dataset.current = 'true';
    chip.textContent = form;
    strip.appendChild(chip);
  }
  return strip;
}

function chipRow(label, words) {
  const row = document.createElement('div');
  row.className = 'kb-row';
  const lab = document.createElement('span');
  lab.className = 'kb-label';
  lab.textContent = label;
  row.appendChild(lab);
  for (const w of words) {
    const chip = document.createElement('span');
    chip.className = 'kb-chip';
    chip.textContent = w;
    row.appendChild(chip);
  }
  return row;
}

/**
 * Build a fragment of KB detail rows, or null if there is nothing rich to show.
 * @param {import('./definitionsCache.js').KbDetails} [kb]
 * @param {string} [word] the normalized word being looked up (marked as current
 *   inside its family)
 * @param {{ onForm?: (form: string) => void, canGo?: (form: string) => boolean }} [opts]
 *   when `onForm` is given, the family's other forms become buttons that navigate
 *   to that word (the Dictionary hub scrolls to its row; the Swiper jumps to its
 *   card). `canGo` filters which forms actually have somewhere to go — a form the
 *   Swiper's deck doesn't hold stays a plain chip rather than a button that lies.
 * @returns {DocumentFragment | null}
 */
export function renderKbDetails(kb, word, { onForm, canGo } = {}) {
  if (!kb) return null;
  const pos = usefulPos(kb.pos || []);
  const family = kb.family && kb.family.forms?.length > 1 ? kb.family : null;
  // The family already lists the paradigm (and names it in its banner), so the
  // standalone "form of" banner and the verb-tense row are only for entries cached
  // before families existed, or served by a KB that doesn't send one.
  const tenses = family ? [] : groupTenses(kb.inflections || []);
  const synonyms = kb.synonyms || [];
  const antonyms = kb.antonyms || [];
  const formOf = !family && kb.formOf?.lemma ? kb.formOf : null;
  if (!pos.length && !tenses.length && !synonyms.length && !antonyms.length && !formOf && !family) return null;

  const frag = document.createDocumentFragment();
  const wrap = document.createElement('div');
  wrap.className = 'kb-details';

  if (family) wrap.appendChild(familyCard(family, word, onForm, canGo));

  // "Past tense of come" — an inflected form pointing at its base word.
  if (formOf) {
    const row = document.createElement('div');
    row.className = 'kb-row kb-formof';
    row.append(`${formOfLabel(formOf.tags)} of `);
    const lemma = document.createElement('b');
    lemma.textContent = formOf.lemma;
    row.appendChild(lemma);
    wrap.appendChild(row);
  }

  if (pos.length) {
    const row = document.createElement('div');
    row.className = 'kb-row kb-pos';
    row.textContent = pos.map(posLabel).join(' · ');
    wrap.appendChild(row);
  }

  if (tenses.length) {
    const row = document.createElement('div');
    row.className = 'kb-row kb-tenses';
    const lab = document.createElement('span');
    lab.className = 'kb-label';
    lab.textContent = 'Verb tenses';
    row.appendChild(lab);
    for (const [tag, forms] of tenses) {
      const t = document.createElement('span');
      t.className = 'kb-tense';
      const b = document.createElement('b');
      b.textContent = tag;
      t.append(b, ` ${forms.join(', ')}`);
      row.appendChild(t);
    }
    wrap.appendChild(row);
  }

  if (synonyms.length) wrap.appendChild(chipRow('Synonyms', synonyms));
  if (antonyms.length) wrap.appendChild(chipRow('Antonyms', antonyms));

  frag.appendChild(wrap);
  return frag;
}
