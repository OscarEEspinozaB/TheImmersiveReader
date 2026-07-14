// The lemma layer: what other word a token is a form OF, and the whole family of
// forms that word inflects into.
//
// Two rules hold this together:
//
//  • A form only means something together with its PART OF SPEECH. "cats" is the
//    plural of the noun *cat* and the third-person singular of the verb *to cat* —
//    reading the dump without the part of speech is what used to make the reader
//    announce "cats: third-person singular of cat", which is false for every
//    sentence it will ever appear in.
//  • This layer never touches word STATE. It groups words for LOOKING UP and for
//    COUNTING; marking "go" as known says nothing about "went", which the reader
//    still has to meet and mark on its own. (Contrast with contractions, which are
//    the mirror image: one token that decomposes INTO lemmas, where marking does
//    propagate. Families group N tokens INTO one lemma, and marking never does.)

// When a form belongs to several paradigms of the SAME lemma, this decides which
// one the banner names. A learner meets "cats" as a plural noun far more often
// than as a conjugated verb, and nouns are the largest open class — so noun wins,
// then verb, then the degrees.
const POS_RANK = { noun: 0, verb: 1, adj: 2, adv: 3, pron: 4, det: 5 };
const rank = (pos) => (pos in POS_RANK ? POS_RANK[pos] : 9);

// The order a learner reads a paradigm in, and — since the first tag is the one
// the banner names — the order that decides what "walked" is called. It is both
// the past and the past participle of walk; "past tense of walk" is the plainer
// half of that truth, so it leads.
const TAG_ORDER = [
  'base',
  'past',
  'past participle',
  'present participle',
  'third-person singular',
  'first-person singular',
  'present',
  'past plural',
  'plural',
  'comparative',
  'superlative',
  'objective',
  'possessive determiner',
  'possessive pronoun',
  'reflexive',
  'plural reflexive',
];
const tagRank = (tag) => {
  const i = TAG_ORDER.indexOf(tag);
  return i === -1 ? TAG_ORDER.length : i;
};
const byTag = (a, b) => tagRank(a) - tagRank(b);

/**
 * The word `word` is an inflected form of — e.g. "came" → come (past), "mice" →
 * mouse (plural), "me" → I (objective). Null when the word is its own lemma.
 *
 * Kaikki lists a form under every lemma that can produce it ("came" → come / cum /
 * coom), so candidates are ranked by how well attested the lemma is (its sense
 * count), then by part of speech. A hand-curated row (paradigms.js) skips the
 * ranking entirely — it was checked by a human.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} lang
 * @param {string} word normalized word
 * @returns {{ lemma: string, pos: string, tags: string[] } | null}
 */
export function formOf(db, lang, word) {
  const rows = db
    .prepare(
      `SELECT e.word AS lemma, i.pos AS pos, i.tag AS tag, i.curated AS curated,
              (SELECT COUNT(*) FROM senses s WHERE s.entry_id = i.entry_id) AS senses
       FROM inflections i JOIN entries e ON e.id = i.entry_id
       WHERE i.form = ? AND i.entry_id LIKE ? AND e.word <> ?`,
    )
    .all(word, `${lang}:%`, word);
  if (!rows.length) return null;

  // One candidate per (lemma, pos): "was" is one link to BE, not two because the
  // dump happens to tag it twice.
  const byParadigm = new Map();
  for (const r of rows) {
    const key = `${r.lemma}:${r.pos}`;
    if (!byParadigm.has(key)) {
      byParadigm.set(key, { lemma: r.lemma, pos: r.pos, tags: new Set(), senses: r.senses, curated: !!r.curated });
    }
    byParadigm.get(key).tags.add(r.tag);
  }
  const candidates = [...byParadigm.values()];

  const best = candidates.sort((a, b) => {
    if (a.curated !== b.curated) return a.curated ? -1 : 1; // hand-checked wins
    if (b.senses !== a.senses) return b.senses - a.senses; // best-attested lemma
    return rank(a.pos) - rank(b.pos);
  })[0];

  // A curated paradigm is trusted as-is: "me" has a fat dictionary entry of its
  // own (the note, the letter, the pronoun), so the sense-count guard below would
  // wrongly cut its link to "I" — exactly the kind of high-frequency word the
  // hand-written table exists to protect.
  if (best.curated) return { lemma: best.lemma, pos: best.pos, tags: [...best.tags].sort(byTag) };

  // `word` almost always has its own dictionary entry too, even when it is ALSO
  // an inflected form of some other (often rarer/dialectal) verb — e.g. "run" is
  // a well-attested lemma in its own right AND happens to be the past participle
  // of the archaic/dialectal "rin". Only treat `word` as an inflected form when
  // the candidate lemma is at least as well-attested as `word` itself.
  const ownSenses = db
    .prepare('SELECT COUNT(*) AS c FROM senses WHERE entry_id = ?')
    .get(`${lang}:${word}`).c;
  if (best.senses <= ownSenses) return null;

  return { lemma: best.lemma, pos: best.pos, tags: [...best.tags].sort(byTag) };
}

/**
 * The whole family a word belongs to: its lemma, how this word relates to it, and
 * every form the lemma inflects into — the data behind the "gone → past participle
 * of GO · go goes going went gone" card. The reader colors each of those forms with
 * the state IT actually has, so the learner sees the paradigm instead of five
 * unrelated red words.
 *
 * One entry per distinct SURFACE form, because that is what the reader colors and
 * what the learner has to recognize: "walked" is both the past and the past
 * participle of walk, and it is one word to learn, not two. The lemma leads the
 * list (tagged "base"), and merges with a form equal to it — "sheep" comes back as
 * a single chip tagged base + plural, which is exactly the lesson.
 *
 * Returns null for a word with no inflections at all; the popup then shows what it
 * always did.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} lang
 * @param {string} word normalized word (a lemma or one of its forms)
 * @returns {{ lemma: string, pos: string, tag: string | null,
 *             forms: { form: string, tags: string[] }[] } | null}
 */
export function family(db, lang, word) {
  const inflected = formOf(db, lang, word);
  const lemma = inflected ? inflected.lemma : word;

  const rows = db
    .prepare('SELECT pos, tag, form FROM inflections WHERE entry_id = ?')
    .all(`${lang}:${lemma}`);
  if (!rows.length) return null; // not an inflecting word — nothing to group

  // The paradigm this word belongs to: the one it is a form of, or (when the word
  // IS the lemma) the most learner-relevant one it has. Only that paradigm's forms
  // are shown — the noun *cat* must not drag in "catted" from the verb.
  const pos = inflected ? inflected.pos : rows.map((r) => r.pos).sort((a, b) => rank(a) - rank(b))[0];

  const byForm = new Map([[lemma, ['base']]]);
  for (const r of rows) {
    if (r.pos !== pos) continue;
    const tags = byForm.get(r.form);
    if (tags) {
      if (!tags.includes(r.tag)) tags.push(r.tag);
    } else {
      byForm.set(r.form, [r.tag]);
    }
  }

  const forms = [...byForm]
    .map(([form, tags]) => ({ form, tags: tags.sort(byTag) }))
    .sort((a, b) => byTag(a.tags[0], b.tags[0]));

  return {
    lemma,
    pos,
    tag: inflected ? inflected.tags[0] : null,
    forms,
  };
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
    .prepare("SELECT tag, form FROM inflections WHERE entry_id = ? AND pos = 'verb' ORDER BY LENGTH(form)")
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
