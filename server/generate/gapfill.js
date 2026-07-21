// External gap-fill: seed KB entries from public dictionaries for words the offline
// dump does not have.
//
// Two holes this closes:
//  1. ENGLISH GAPS — the Kaikki dump misses in-universe coinages and slang
//     ("Quidditch", "Muggle"). They used to end the build as `absent`.
//  2. LANGUAGES WITH NO DUMP AT ALL — es/fr/it/pt have no Kaikki file here, so
//     /define missed every word. Each Wiktionary edition defines its own words in
//     its own language, so we read the book's language edition and store a real
//     MONOLINGUAL definition (a Spanish book gets Spanish, not an English gloss).
//
// Source per language — deliberately never a cross-language gloss: storing
// "huérfano → orphan" in a Spanish KB would be a translation masquerading as a
// definition, so a language without a validated parser stores NOTHING and stays
// `absent` (the client's own provider chain is still its fallback at read time).
//
//   en          freedictionaryapi.com  — structured JSON, English definitions
//   es          es.wiktionary.org      — plain-text extract, numbered senses
//   fr, it, pt  <lang>.wiktionary.org  — rendered HTML, first <ol><li>
//   de, ko, …   (none yet — their editions lay definitions out differently:
//                German uses <dl>/<dd> under "Bedeutungen". Needs its own parser.)
//
// Everything written here is stamped provenance `dictionary-api`, so a later
// Wiktextract dump (or a hand edit) can tell these rows from dumped ones.

import { normalize } from '../../src/normalize.js';
import { KB_SCHEMA_VERSION } from '../db.js';

/**
 * Does this language's KB get AI-REFINED, or is it seeded raw?
 *
 * English is refined; every other language is served exactly what its own
 * Wiktionary said, because the refiner writes simple English and would turn a
 * Spanish definition into a translation. This one predicate is what "built" means,
 * and coverage, `/words` and `/stats` must all agree on it — when they disagreed,
 * a Spanish book with a real dictionary behind it reported "0 built words".
 */
export const isRefinedLanguage = (lang) => lang === 'en';

const TIMEOUT = 8000; // ms — a batch build can wait, but never hang on a dead host
const MAX_SENSES = 8; // what the refiner reads; more is noise
// Wikimedia asks API clients to identify themselves; a browser can't set this but
// the server can, so we do.
const UA = 'TheImmersiveReader/1.0 (personal language-learning app)';

/**
 * Ask a source, keeping "no dictionary has this word" apart from "we could not
 * ask". The first is a permanent fact about the WORD; the second is a fact about
 * the NETWORK, and collapsing them would put real vocabulary on the miss list
 * because of one timeout or one 429 — a list that is then never retried, and that
 * a reader reviews in bulk. So a transient failure records nothing and is simply
 * tried again on the next build.
 * @returns {Promise<{ data?: object, notFound?: true, transient?: true }>}
 */
// Wikimedia throttles bursts: twelve back-to-back requests already draw a 429 with
// `Retry-After: 5`. A book is ~8000 words, which is nothing BUT a burst, and every
// throttled word comes back looking like a transient failure that the next run has
// to redo — a build that never converges. So pace the calls (they are serial anyway)
// and, when told to wait, actually wait and retry once.
const MIN_INTERVAL_MS = 300;
const MAX_BACKOFF_S = 30;
let lastRequestAt = 0;

async function pace() {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function getJson(url, { mayRetry = true } = {}) {
  await pace();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA } });
    if (res.status === 429 && mayRetry) {
      const after = Math.min(Number(res.headers.get('retry-after')) || 5, MAX_BACKOFF_S);
      await new Promise((r) => setTimeout(r, after * 1000));
      return getJson(url, { mayRetry: false }); // one honest retry, then give up
    }
    if (res.status === 404) return { notFound: true }; // the source answered: nothing here
    if (!res.ok) return { transient: true }; // still throttled, or 5xx — ask again later
    return { data: await res.json() };
  } catch {
    return { transient: true }; // offline / timeout / DNS
  } finally {
    clearTimeout(timer);
  }
}

// --- Source 1: freedictionaryapi.com (English) --------------------------------

// freedictionaryapi's part-of-speech words → the codes the KB's inflections table
// uses, so a seeded form is never mislabelled (a noun plural is not a verb tense).
const POS_CODE = { noun: 'noun', verb: 'verb', adjective: 'adj', adverb: 'adv', pronoun: 'pron', determiner: 'det' };

// Senses that define a SPELLING rather than a meaning. Wiktionary uses them to
// point one case/spelling variant at another ("Alternative letter-case form of
// Quidditch"), which is not something a reader can learn from — and it is exactly
// what a lowercase lookup of a proper noun returns. Same family the kb:audit
// script rejects.
const NON_DEFINITION = /^(?:alternative|obsolete|archaic|common)?\s*(?:letter-case|spelling|form)\b|^(?:misspelling|alternative form|alternative spelling|alternative letter-case form) of\b/i;

async function fetchFreeDictEntries(lang, word) {
  const r = await getJson(
    `https://freedictionaryapi.com/api/v1/entries/${lang}/${encodeURIComponent(word)}`,
  );
  if (r.transient) return { transient: true };
  return { entries: Array.isArray(r.data?.entries) ? r.data.entries : [] };
}

async function fromFreeDictionaryApi(lang, word) {
  // The KB keys words lowercase, but a proper noun keeps its meaning under the
  // CAPITALIZED entry ("muggle" is marijuana, "Muggle" is the Harry Potter one) —
  // so read both and merge, or a reader of that book gets the wrong word entirely.
  const capitalized = word.charAt(0).toUpperCase() + word.slice(1);
  const first = await fetchFreeDictEntries(lang, word);
  if (first.transient) return { transient: true };
  const entries = [...first.entries];
  if (capitalized !== word) {
    await new Promise((r) => setTimeout(r, 200)); // be gentle with the public API
    const second = await fetchFreeDictEntries(lang, capitalized);
    // Only the capitalized half failing is not fatal — unless it was our only hope.
    if (second.transient && !entries.length) return { transient: true };
    if (second.entries) entries.push(...second.entries);
  }
  if (!entries.length) return { entry: null };

  const pos = [];
  const senses = [];
  const inflections = [];
  const seenDefs = new Set();
  for (const e of entries) {
    if (e.partOfSpeech && !pos.includes(e.partOfSpeech)) pos.push(e.partOfSpeech);

    const code = POS_CODE[e.partOfSpeech];
    if (code) {
      for (const f of e.forms || []) {
        const form = typeof f?.word === 'string' ? normalize(f.word) : '';
        const tag = (f?.tags || []).join(' ').trim();
        // Dialectal/alternative spellings are not paradigm members — the family
        // card would read "dog · darg · dawg · doggo" and mean nothing.
        if (!form || !tag || /alternative|dialectal|obsolete|archaic|rare/i.test(tag)) continue;
        inflections.push({ pos: code, tag, form });
      }
    }

    for (const s of e.senses || []) {
      const definition = (s.definition || '').trim().replace(/\s+/g, ' ');
      if (!definition || senses.length >= MAX_SENSES) continue;
      if (NON_DEFINITION.test(definition)) continue; // a spelling pointer, not a meaning
      if (seenDefs.has(definition)) continue; // the two case variants overlap
      seenDefs.add(definition);
      senses.push({
        definition,
        example: (s.examples || [])[0] || null,
        synonyms: (s.synonyms || []).concat(e.synonyms || []),
        antonyms: (s.antonyms || []).concat(e.antonyms || []),
      });
    }
  }
  if (!senses.length) return { entry: null };
  return { entry: { pos, senses, inflections, sourceName: 'freedictionaryapi.com' } };
}

// --- Source 2: a Wiktionary edition in its OWN language -----------------------

// The language's own name, as its Wiktionary edition titles the section. A page can
// document the same spelling in several languages; only this section is ours.
const ENDONYM = {
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  pt: 'Português',
};

// A book's language code is not always a Wiktionary edition. The app tags
// Portuguese books `pt-BR` (that is what Intl.Segmenter wants), but Wiktionary has
// a single Portuguese edition at `pt` — asking for pt-BR.wiktionary.org resolves to
// nothing and silently seeds an empty dictionary. The KB still keys the entry by the
// BOOK's language, so lookups keep matching; only the fetch is remapped.
const WIKI_EDITION = { 'pt-BR': 'pt' };
const editionOf = (lang) => WIKI_EDITION[lang] || lang;

function wikiApi(lang, params) {
  const q = new URLSearchParams({ format: 'json', redirects: '1', ...params });
  return `https://${editionOf(lang)}.wiktionary.org/w/api.php?${q}`;
}

// Strip tags/entities from an HTML fragment and collapse whitespace. Removing the
// inline links that wrap half the words leaves gaps around punctuation
// ("( Cynologie ) Mammifère , apparenté"), so close those back up.
function textOf(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;:.!?»)\]])/g, '$1')
    .replace(/([(\[«])\s+/g, '$1')
    .trim();
}

/**
 * es.wiktionary lays its senses out as a bare number line ("1") followed by the
 * definition, under a "==== Part of speech ====" header, with "Sinónimo:" lines
 * attached — so the plain-text extract is the cleanest read for Spanish.
 */
async function fromSpanishWiktionary(word) {
  const r = await getJson(
    wikiApi('es', { action: 'query', titles: word, prop: 'extracts', explaintext: '1', exsectionformat: 'wiki' }),
  );
  if (r.transient) return { transient: true };
  const pages = r.data?.query?.pages;
  const text = pages ? Object.values(pages)[0]?.extract || '' : '';
  if (!text) return { entry: null };

  const lines = text.split('\n');
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^==\s*([^=].*?)\s*==$/);
    if (!m) continue;
    if (/español/i.test(m[1])) start = i;
    else if (start >= 0) {
      end = i;
      break;
    }
  }
  if (start < 0) return { entry: null };
  const sec = lines.slice(start, end);

  let curPos = null;
  let pos = null;
  let definition = null;
  let defAt = -1;
  for (let i = 0; i < sec.length; i += 1) {
    const h = sec[i].match(/^====\s*(.+?)\s*====$/);
    if (h) {
      curPos = h[1];
      continue;
    }
    if (/^\d+\.?$/.test(sec[i].trim())) {
      for (let j = i + 1; j < sec.length; j += 1) {
        const t = sec[j].trim();
        if (t) {
          definition = t;
          pos = curPos;
          defAt = i;
          break;
        }
      }
      break;
    }
  }
  if (!definition) return { entry: null };

  // Synonyms of that first sense only (up to the next numbered sense).
  const synonyms = [];
  for (let i = defAt + 1; i < sec.length && synonyms.length < 8; i += 1) {
    if (/^\d+\.?$/.test(sec[i].trim())) break;
    const ms = sec[i].trim().match(/^Sin[oó]nimos?:\s*(.+)$/);
    if (!ms) continue;
    for (const part of ms[1].split(',')) {
      const s = part.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[.;]+$/, '').trim();
      if (s && !synonyms.includes(s)) synonyms.push(s);
    }
  }

  return {
    entry: {
      pos: pos ? [pos] : [],
      senses: [{ definition, example: null, synonyms, antonyms: [] }],
      inflections: [],
      sourceName: 'es.wiktionary.org',
    },
  };
}

/**
 * fr/it/pt: the rendered HTML is the reliable read — definitions are <ol><li>,
 * while examples and citations are nested <dl>/<ul> INSIDE the <li>. Cutting the
 * item at its first nested list is what separates the definition from the quote
 * that follows it (the plain-text extract flattens both into one blob).
 */
async function fromWiktionaryHtml(lang, word) {
  const endonym = ENDONYM[editionOf(lang)];
  if (!endonym) return { unsupported: true };
  const r = await getJson(wikiApi(lang, { action: 'parse', page: word, prop: 'text', formatversion: '2' }));
  if (r.transient) return { transient: true };
  const html = r.data?.parse?.text;
  if (typeof html !== 'string' || !html) return { entry: null };

  // Scope to the language's own section. Editions disagree on the heading LEVEL
  // they give a language — pt.wiktionary titles it "= Português =" (h1) where fr
  // and it use h2 — so match whichever level carries the endonym, then run to the
  // next heading of that same level (where the next language starts).
  const head = html.match(new RegExp(`<h([12])[^>]*>(?:(?!</h\\1>).)*?${endonym}(?:(?!</h\\1>).)*?</h\\1>`, 's'));
  if (!head) return { entry: null };
  let sec = html.slice(head.index + head[0].length);
  const nextLang = sec.search(new RegExp(`<h${head[1]}\\b`));
  if (nextLang >= 0) sec = sec.slice(0, nextLang);

  // First definition list, first item, cut before its examples/sub-senses.
  const ol = sec.search(/<ol[^>]*>/);
  if (ol < 0) return { entry: null };
  const li = sec.slice(ol).match(/<li[^>]*>([\s\S]*)/);
  if (!li) return { entry: null };
  const cut = li[1].search(/<dl\b|<ul\b|<ol\b|<\/li>/);
  const definition = textOf(cut >= 0 ? li[1].slice(0, cut) : li[1]);
  if (!definition) return { entry: null };

  // The part of speech is the last SUBheading before that list ("Nom commun").
  // Anything inside `sec` is already below the language heading, so any level goes
  // — which is what keeps this working whether the language sat at h1 or h2.
  const headings = [...sec.slice(0, ol).matchAll(/<h[2-6][^>]*>[\s\S]*?<\/h[2-6]>/g)];
  const pos = headings.length ? textOf(headings[headings.length - 1][0]) : null;

  return {
    entry: {
      pos: pos ? [pos] : [],
      senses: [{ definition, example: null, synonyms: [], antonyms: [] }],
      inflections: [],
      sourceName: `${editionOf(lang)}.wiktionary.org`,
    },
  };
}

/**
 * Fetch one word from whichever external source serves this language, normalized
 * to the shape the KB stores. The three outcomes are kept apart on purpose,
 * because only ONE of them is a fact about the word:
 *   { entry }              found
 *   { entry: null }        the sources answered and have no such word  → a miss
 *   { transient: true }    we could not ask (offline, timeout, 429)    → retry
 *   { unsupported: true }  WE have no parser for this edition yet      → retry
 * `unsupported` is our gap, not the word's: recording German words as misses now
 * would make them all skip the day a German parser lands.
 * @returns {Promise<{ entry?: object | null, transient?: true, unsupported?: true }>}
 */
export async function fetchExternal(lang, word) {
  if (lang === 'en') return fromFreeDictionaryApi('en', word);
  if (editionOf(lang) === 'es') return fromSpanishWiktionary(word);
  if (ENDONYM[editionOf(lang)]) return fromWiktionaryHtml(lang, word);
  return { unsupported: true };
}

// --- Storage ------------------------------------------------------------------

/**
 * Write a fetched entry into the KB, mirroring what the Kaikki ingest writes
 * (entries + senses + relations + inflections) and stamping provenance so these
 * rows are always distinguishable from dumped ones.
 * @returns {boolean} whether anything was stored
 */
export function storeExternal(db, lang, word, data) {
  const id = `${lang}:${word}`;
  const upsertEntry = db.prepare(`
    INSERT INTO entries (id, lang, word, pos, schema_version) VALUES (@id, @lang, @word, @pos, @sv)
    ON CONFLICT(id) DO UPDATE SET pos = (
      SELECT json_group_array(DISTINCT value) FROM (
        SELECT value FROM json_each(entries.pos)
        UNION SELECT value FROM json_each(excluded.pos)
      )
    )
  `);
  const senseOrd = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS next FROM senses WHERE entry_id = ?');
  const insertSense = db.prepare('INSERT OR IGNORE INTO senses (entry_id, definition, example, ord) VALUES (?, ?, ?, ?)');
  const getSenseId = db.prepare('SELECT id FROM senses WHERE entry_id = ? AND definition = ?');
  const insertRelation = db.prepare('INSERT OR IGNORE INTO relations (from_sense, to_word, type) VALUES (?, ?, ?)');
  const insertInflection = db.prepare(
    'INSERT OR IGNORE INTO inflections (entry_id, pos, tag, form, curated) VALUES (?, ?, ?, ?, 0)',
  );
  const stampProv = db.prepare(`
    INSERT INTO provenance (entry_id, field_path, source, source_name, generated_at, locked)
    VALUES (?, 'senses', 'dictionary-api', ?, ?, 0)
    ON CONFLICT(entry_id, field_path) DO UPDATE SET
      source = 'dictionary-api', source_name = excluded.source_name,
      generated_at = excluded.generated_at
    WHERE provenance.locked = 0
  `);

  const addRelations = (senseId, list, type) => {
    for (const raw of list || []) {
      const to = typeof raw === 'string' ? normalize(raw) : '';
      if (to && !/\s/.test(to)) insertRelation.run(senseId, to, type);
    }
  };

  let stored = false;
  db.transaction(() => {
    upsertEntry.run({ id, lang, word, pos: JSON.stringify(data.pos || []), sv: KB_SCHEMA_VERSION });

    let ord = senseOrd.get(id).next;
    for (const s of data.senses || []) {
      const info = insertSense.run(id, s.definition, s.example || null, ord);
      let senseId;
      if (info.changes) {
        senseId = info.lastInsertRowid;
        ord += 1;
        stored = true;
      } else {
        senseId = getSenseId.get(id, s.definition)?.id;
      }
      if (senseId) {
        addRelations(senseId, s.synonyms, 'synonym');
        addRelations(senseId, s.antonyms, 'antonym');
      }
    }

    for (const f of data.inflections || []) insertInflection.run(id, f.pos, f.tag, f.form);
    stampProv.run(id, data.sourceName, Date.now());
  })();

  return stored;
}

// --- The "not processed" list -------------------------------------------------

/**
 * Has this word already been asked of the external sources and not found? A book
 * of invented names (Gringotts, Quirrell) or dialect spelling (Hagrid's "yeh'll")
 * carries ~150 of them, and without this every rebuild would re-run the same
 * fruitless network calls.
 */
export function isKnownMiss(db, lang, word) {
  return !!db.prepare('SELECT 1 FROM gapfill_misses WHERE lang = ? AND word = ?').get(lang, word);
}

/** Record (or bump) a word no public dictionary could answer. */
export function recordMiss(db, lang, word) {
  db.prepare(
    `INSERT INTO gapfill_misses (lang, word, tried_at, tries) VALUES (?, ?, ?, 1)
     ON CONFLICT(lang, word) DO UPDATE SET tried_at = excluded.tried_at, tries = tries + 1`,
  ).run(lang, word, Date.now());
}

/**
 * The words this language asked for and never got — the reviewable list. Mostly
 * proper nouns and dialect spellings; showing them is all this does.
 * @returns {{ word: string, triedAt: number, tries: number }[]}
 */
export function listMisses(db, lang, { limit = 2000 } = {}) {
  return db
    .prepare('SELECT word, tried_at AS triedAt, tries FROM gapfill_misses WHERE lang = ? ORDER BY word LIMIT ?')
    .all(lang, limit);
}

/**
 * Fetch + store one missing word. The single call the build pipeline makes when a
 * word is not in the KB at all. A word already on the miss list is skipped without
 * touching the network, unless `retry` is set.
 * @returns {Promise<string | null>} the source it came from, or null if unfilled
 */
export async function gapFill(db, lang, word, { retry = false } = {}) {
  if (!retry && isKnownMiss(db, lang, word)) return null;

  const { entry, transient, unsupported } = await fetchExternal(lang, word);
  // Neither of these says anything about the word, so neither is recorded: the
  // next build simply asks again.
  if (transient || unsupported) return null;

  if (!entry || !storeExternal(db, lang, word, entry)) {
    recordMiss(db, lang, word); // the sources answered, and they have no such word
    return null;
  }
  // It answered this time — drop any stale miss so the list stays honest.
  db.prepare('DELETE FROM gapfill_misses WHERE lang = ? AND word = ?').run(lang, word);
  return entry.sourceName;
}
