// Render the rich linguistic data from a local-KB definition (the `kb` payload
// attached by definitions/kbApi.js) into DOM: part of speech, verb tenses,
// synonyms and antonyms. Shared by the reader popup and the Dictionary tab so
// both surfaces show the same detail instead of just the first definition line.

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
};

// Order the verb-tense tags the way a learner reads them, regardless of dump order.
const TENSE_ORDER = ['past', 'past participle', 'present participle', 'third-person singular'];

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
 * @param {{ pos?: string[], inflections?: {tag:string,form:string}[], synonyms?: string[], antonyms?: string[] }} [kb]
 * @returns {DocumentFragment | null}
 */
export function renderKbDetails(kb) {
  if (!kb) return null;
  const pos = kb.pos || [];
  const tenses = groupTenses(kb.inflections || []);
  const synonyms = kb.synonyms || [];
  const antonyms = kb.antonyms || [];
  if (!pos.length && !tenses.length && !synonyms.length && !antonyms.length) return null;

  const frag = document.createDocumentFragment();
  const wrap = document.createElement('div');
  wrap.className = 'kb-details';

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
