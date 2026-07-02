// Detect that a word is an inflected form of a base word (lemma) — e.g. "came" is
// the past of "come" — from the deterministic inflections table. Kaikki stores an
// inflected form on several lemmas ("came" → come / cum / coom); we pick the most
// "real" one (the candidate entry with the most senses). Returns { lemma, tags },
// or null if the word is its own lemma (not a form of anything else).

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} lang
 * @param {string} word normalized word
 * @returns {{ lemma: string, tags: string[] } | null}
 */
export function formOf(db, lang, word) {
  const rows = db
    .prepare(
      `SELECT e.word AS lemma, i.tag AS tag,
              (SELECT COUNT(*) FROM senses s WHERE s.entry_id = i.entry_id) AS senses
       FROM inflections i JOIN entries e ON e.id = i.entry_id
       WHERE i.form = ? AND i.entry_id LIKE ? AND e.word <> ?`,
    )
    .all(word, `${lang}:%`, word);
  if (!rows.length) return null;

  const byLemma = new Map();
  for (const r of rows) {
    if (!byLemma.has(r.lemma)) byLemma.set(r.lemma, { lemma: r.lemma, tags: new Set(), senses: r.senses });
    byLemma.get(r.lemma).tags.add(r.tag);
  }
  const best = [...byLemma.values()].sort((a, b) => b.senses - a.senses)[0];

  // `word` almost always has its own dictionary entry too, even when it is ALSO
  // an inflected form of some other (often rarer/dialectal) verb — e.g. "run" is
  // a well-attested lemma in its own right AND happens to be the past participle
  // of the archaic/dialectal "rin". Only treat `word` as an inflected form when
  // the candidate lemma is at least as well-attested as `word` itself.
  const ownSenses = db
    .prepare('SELECT COUNT(*) AS c FROM senses WHERE entry_id = ?')
    .get(`${lang}:${word}`).c;
  if (best.senses <= ownSenses) return null;

  return { lemma: best.lemma, tags: [...best.tags] };
}

/**
 * The deterministic verb-tense paradigm for a word, from the same `inflections`
 * table `formOf` reads — used to GROUND the AI explain prompt (server/generate/
 * explain.js) with real forms instead of letting the model invent them (a small
 * local model will otherwise hallucinate, e.g. "wrestled" -> "wrestleled").
 * Resolves `word` to its lemma first if it is itself an inflected form.
 * @param {import('better-sqlite3').Database} db
 * @param {string} lang
 * @param {string} word normalized word (lemma or inflected form)
 * @returns {{ lemma: string, forms: Record<string, string> } | null} null if the
 *   KB has no verb-tense data for this word (not a verb, or not in the dataset)
 */
// The Kaikki dump stores archaic English forms ("thou wrestledst", "he
// wrestleth") under the same tags as the modern ones, so a lemma can have more
// than one row per tag. Modern forms never end this way, so when a modern-
// looking alternative exists for the same tag, prefer it.
const ARCHAIC_ENDING = /(st|th)$/;

export function verbForms(db, lang, word) {
  const inflected = formOf(db, lang, word);
  const lemma = inflected ? inflected.lemma : word;
  const rows = db
    .prepare('SELECT tag, form FROM inflections WHERE entry_id = ? ORDER BY LENGTH(form)')
    .all(`${lang}:${lemma}`);
  if (!rows.length) return null;

  const byTag = new Map();
  for (const r of rows) {
    if (!byTag.has(r.tag)) byTag.set(r.tag, []);
    byTag.get(r.tag).push(r.form);
  }
  const forms = {};
  for (const [tag, candidates] of byTag) {
    // A form identical to the lemma is never archaic — modern -st/-th endings
    // are almost always zero-change pasts ("cost", "cast", "burst", "bust"),
    // while the archaic thou/he forms ("didst", "doth") never equal the lemma.
    // Without this guard, past: ["bust", "busted"] would drop "bust" and then
    // wrongly assert "busted" as the one true form.
    const modern = candidates.filter((f) => f === lemma || !ARCHAIC_ENDING.test(f));
    const resolved = modern.length ? modern : candidates;
    // The archaic-suffix filter above only catches the "thou -st" / "he -eth"
    // pattern; the dump also has unrelated dialectal/obsolete forms under the
    // same tag ("go" past: went/yode/goed) that don't match it. When more than
    // one candidate survives, we can't tell which is standard — don't assert a
    // possibly-wrong "known fact" into the prompt, just leave the tag out and
    // let the model use its own (usually correct) knowledge for it.
    if (resolved.length === 1) forms[tag] = resolved[0];
  }
  return { lemma, forms };
}
