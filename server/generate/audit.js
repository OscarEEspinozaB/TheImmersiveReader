// KB audit:  node server/generate/audit.js [lang] [--fix] [--batch N] [--model M]
//
// An entry can be WRONG in ways nothing else notices: it was generated under rules
// we have since abandoned, it defines a word by pointing at another word, or it
// exists at all when it shouldn't (a refined row on an inflected form, now that
// forms are served their lemma's entry). Left alone, those rows are what the reader
// actually reads.
//
// So this walks every refined row, sorts it into a verdict, and — with --fix —
// repairs it: dropping the rows that should not exist, and re-generating the rest
// with the local Ollama, newest contract, a batch at a time (resumable: a repaired
// row is stamped with the current rev and never comes back).
//
// Without --fix it only reports, with examples. Run it after any change to the
// refine prompt, and after a fresh ingest (the POS cleanup below is undone by a
// re-ingest, which re-merges the dump's incidental parts of speech).

import { getDb } from '../db.js';
import { formOf } from '../lemma.js';
import { refineWords } from './build.js';
import { REFINE_REV, REFINE_MODEL } from './ollama.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const lang = args[0] && !args[0].startsWith('--') ? args[0] : 'en';
const FIX = flag('--fix');
const BATCH = Number(value('--batch', '100'));
const MODEL = value('--model', REFINE_MODEL);

// Parts of speech Wiktionary attaches to almost any word (the surname, the brand,
// the letter of the alphabet). True, useless, and merged into the entry's POS list
// by the ingest — which is how a common verb ends up reading "name · noun · verb".
const INCIDENTAL_POS = ['name', 'character'];

// A definition that only points at another word ("Plural of mouse.") teaches
// nothing: the app already states the grammar above it, and the learner is left
// with no meaning at all.
const POINTER_DEF =
  /^(?:the\s+)?(?:simple\s+)?(?:plural|singular|past tense|past participle|present participle|third-person singular|comparative|superlative|alternative[a-z\s-]*|inflection|form)\s+(?:form\s+)?of\b/i;

// Wiktextract noise that should never have survived refinement.
const DUMP_NOISE = /alternative letter-case|wiktionary|misspelling of|obsolete form of/i;

/**
 * What is wrong with one refined row, or null if it is fine.
 * @returns {'orphan-form'|'outdated'|'pointer'|'empty'|'noise'|null}
 */
function verdict(db, row) {
  const word = row.entry_id.slice(row.entry_id.indexOf(':') + 1);
  // A form has no entry of its own any more — its lemma's is served instead. The
  // row is not stale, it is unreachable: delete it rather than pay to rebuild it.
  if (formOf(db, lang, word)) return 'orphan-form';

  const def = (row.definition || '').trim();
  if (def.length < 8) return 'empty';
  if (DUMP_NOISE.test(def)) return 'noise';
  if (POINTER_DEF.test(def)) return 'pointer';
  if (row.rev < REFINE_REV) return 'outdated';
  return null;
}

const db = getDb();

// --- 1. Parts of speech ------------------------------------------------------
// Cheap, deterministic, no LLM: drop the incidental POS from any entry that also
// has a real one. An entry that is ONLY a name keeps it (that IS its part of speech).
const posDirty = db
  .prepare(
    `SELECT id, pos FROM entries
     WHERE lang = ? AND (${INCIDENTAL_POS.map(() => "pos LIKE '%' || ? || '%'").join(' OR ')})`,
  )
  .all(lang, ...INCIDENTAL_POS);

let posFixed = 0;
const cleanPos = db.transaction((rows) => {
  const update = db.prepare('UPDATE entries SET pos = ? WHERE id = ?');
  for (const r of rows) {
    let pos;
    try {
      pos = JSON.parse(r.pos || '[]');
    } catch {
      continue;
    }
    const real = pos.filter((p) => !INCIDENTAL_POS.includes(p));
    if (!real.length || real.length === pos.length) continue; // only-a-name, or nothing to drop
    update.run(JSON.stringify(real), r.id);
    posFixed += 1;
  }
});
if (FIX) cleanPos(posDirty);
else {
  for (const r of posDirty) {
    const pos = JSON.parse(r.pos || '[]');
    const real = pos.filter((p) => !INCIDENTAL_POS.includes(p));
    if (real.length && real.length !== pos.length) posFixed += 1;
  }
}

// --- 2. Refined rows ---------------------------------------------------------
const rows = db
  .prepare('SELECT entry_id, definition, rev FROM refined WHERE entry_id LIKE ?')
  .all(`${lang}:%`);

const buckets = new Map(); // verdict -> [word]
for (const row of rows) {
  const v = verdict(db, row);
  if (!v) continue;
  const word = row.entry_id.slice(row.entry_id.indexOf(':') + 1);
  if (!buckets.has(v)) buckets.set(v, []);
  buckets.get(v).push(word);
}

const LABELS = {
  'orphan-form': 'refined rows on an inflected form (its lemma serves it now)',
  outdated: `written under an older contract (rev < ${REFINE_REV})`,
  pointer: 'definition only points at another word ("Plural of mouse.")',
  empty: 'definition too short to mean anything',
  noise: 'dump noise survived refinement',
};

console.log(`\nKB audit (${lang}) — ${rows.length.toLocaleString()} refined entries\n`);
console.log(`  parts of speech to clean : ${posFixed.toLocaleString()}`);
for (const [v, words] of buckets) {
  console.log(`  ${LABELS[v].padEnd(56)} : ${words.length.toLocaleString()}   e.g. ${words.slice(0, 5).join(', ')}`);
}
const healthy = rows.length - [...buckets.values()].reduce((n, w) => n + w.length, 0);
console.log(`  healthy                  : ${healthy.toLocaleString()}\n`);

if (!FIX) {
  console.log('Nothing changed. Re-run with --fix (add --batch N --model M) to repair.\n');
  db.close();
  process.exit(0);
}

console.log(`Cleaned the part of speech on ${posFixed.toLocaleString()} entries.`);

// Orphans are deleted, not rebuilt: the lemma's entry is what /define serves.
const orphans = buckets.get('orphan-form') || [];
if (orphans.length) {
  const del = db.prepare('DELETE FROM refined WHERE entry_id = ?');
  db.transaction(() => orphans.forEach((w) => del.run(`${lang}:${w}`)))();
  console.log(`Deleted ${orphans.length.toLocaleString()} refined rows that belonged to inflected forms.`);
}

// Everything else is re-generated by the local model, oldest contract first, a
// batch at a time — CPU inference is 5-25 s per word, so this is meant to be run
// repeatedly rather than left overnight in one go.
const toRebuild = ['empty', 'noise', 'pointer', 'outdated'].flatMap((v) => buckets.get(v) || []);
if (!toRebuild.length) {
  console.log('Nothing to re-generate.\n');
  db.close();
  process.exit(0);
}

const batch = toRebuild.slice(0, BATCH);
console.log(`\nRe-generating ${batch.length} of ${toRebuild.length.toLocaleString()} entries with ${MODEL} …\n`);

const started = Date.now();
let done = 0;
await refineWords({
  db,
  lang,
  words: batch,
  force: true, // they exist; that is the point
  model: MODEL,
  onResult: (r) => {
    done += 1;
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`  [${done}/${batch.length}] ${r.status.padEnd(8)} ${r.word.padEnd(18)} ${secs}s  ${r.definition || ''}`);
  },
});

const left = toRebuild.length - batch.length;
console.log(`\nDone. ${left.toLocaleString()} still to go — run again to continue.\n`);
db.close();
