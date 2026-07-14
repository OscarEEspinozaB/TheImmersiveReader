// The curated paradigms: the handful of word families written by hand instead of
// read from the Wiktextract dump.
//
// Two groups qualify, for the same reason — the dump is wrong about them and they
// are impossible to avoid while reading:
//
//  • The CLOSED CLASS: pronouns, BE / HAVE / DO, the modals, the demonstratives.
//    A fixed set (~90 surface forms) that will never grow, and the words a learner
//    meets on every line of every book. The dump's BE table has no "am" but offers
//    "wast", "weren" and a bare "s"; its "it" entry lists "they" and "them" as
//    forms of it; its "i" entry has no forms at all (the letter I wins the line).
//  • The IRREGULAR DEGREES: good/better/best, bad/worse/worst, far/farther. The
//    dump does list better/best — under BOTH "good" and "well" — and ranking by
//    sense count picks "well", so a learner tapping "best" would be told it is the
//    superlative of *well*. It is the comparative of both; "good" is the one worth
//    showing.
//
// A curated row wins over anything the dump says: the ingest skips these lemmas
// entirely, and `formOf` trusts a curated row without the sense-count guard it
// applies to dumped data. Grouping is always per (lemma, pos): "I" is a pronoun
// inflecting for case and BE is a verb inflecting for tense — they co-occur
// constantly but are two different paradigms, and nothing here can merge two
// lemmas into one card.

/**
 * @typedef {{ lemma: string, pos: string, forms: { tag: string, form: string }[] }} Paradigm
 */

const f = (tag, ...forms) => forms.map((form) => ({ tag, form }));

/** @type {Record<string, Paradigm[]>} */
export const CURATED = {
  en: [
    // --- The three irregular auxiliaries -------------------------------------
    {
      lemma: 'be',
      pos: 'verb',
      forms: [
        ...f('first-person singular', 'am'),
        ...f('third-person singular', 'is'),
        ...f('present', 'are'),
        ...f('past', 'was'),
        ...f('past plural', 'were'),
        ...f('present participle', 'being'),
        ...f('past participle', 'been'),
      ],
    },
    {
      lemma: 'have',
      pos: 'verb',
      forms: [
        ...f('third-person singular', 'has'),
        ...f('past', 'had'),
        ...f('past participle', 'had'),
        ...f('present participle', 'having'),
      ],
    },
    {
      lemma: 'do',
      pos: 'verb',
      forms: [
        ...f('third-person singular', 'does'),
        ...f('past', 'did'),
        ...f('past participle', 'done'),
        ...f('present participle', 'doing'),
      ],
    },

    // --- Modals. Their "past" is a tense in form only (would/could are mostly
    // conditional in use), but the form-to-form link is exactly what a learner
    // needs to see, and the definition below the banner carries the real meaning.
    { lemma: 'can', pos: 'verb', forms: f('past', 'could') },
    { lemma: 'will', pos: 'verb', forms: f('past', 'would') },
    { lemma: 'shall', pos: 'verb', forms: f('past', 'should') },
    { lemma: 'may', pos: 'verb', forms: f('past', 'might') },

    // --- Pronouns. One card per person: I/me/my/mine/myself group together and
    // with nothing else. (They are SHOWN as a family but each form still counts
    // as its own real word in Progress — for a learner they are four things to
    // learn, not "4/5 of one"; see the `pron` rule in the stats/UI layer.)
    {
      lemma: 'i',
      pos: 'pron',
      forms: [
        ...f('objective', 'me'),
        ...f('possessive determiner', 'my'),
        ...f('possessive pronoun', 'mine'),
        ...f('reflexive', 'myself'),
      ],
    },
    {
      lemma: 'you',
      pos: 'pron',
      forms: [
        ...f('possessive determiner', 'your'),
        ...f('possessive pronoun', 'yours'),
        ...f('reflexive', 'yourself'),
        ...f('plural reflexive', 'yourselves'),
      ],
    },
    {
      lemma: 'he',
      pos: 'pron',
      forms: [
        ...f('objective', 'him'),
        ...f('possessive determiner', 'his'),
        ...f('possessive pronoun', 'his'),
        ...f('reflexive', 'himself'),
      ],
    },
    {
      lemma: 'she',
      pos: 'pron',
      forms: [
        ...f('objective', 'her'),
        ...f('possessive determiner', 'her'),
        ...f('possessive pronoun', 'hers'),
        ...f('reflexive', 'herself'),
      ],
    },
    {
      lemma: 'it',
      pos: 'pron',
      forms: [...f('possessive determiner', 'its'), ...f('reflexive', 'itself')],
    },
    {
      lemma: 'we',
      pos: 'pron',
      forms: [
        ...f('objective', 'us'),
        ...f('possessive determiner', 'our'),
        ...f('possessive pronoun', 'ours'),
        ...f('reflexive', 'ourselves'),
      ],
    },
    {
      lemma: 'they',
      pos: 'pron',
      forms: [
        ...f('objective', 'them'),
        ...f('possessive determiner', 'their'),
        ...f('possessive pronoun', 'theirs'),
        ...f('reflexive', 'themselves'),
      ],
    },
    {
      lemma: 'who',
      pos: 'pron',
      forms: [...f('objective', 'whom'), ...f('possessive determiner', 'whose')],
    },

    // --- Demonstratives: the only determiners that inflect for number.
    { lemma: 'this', pos: 'det', forms: f('plural', 'these') },
    { lemma: 'that', pos: 'det', forms: f('plural', 'those') },

    // --- Irregular degrees. Suppletive: nothing about "better" says "good".
    {
      lemma: 'good',
      pos: 'adj',
      forms: [...f('comparative', 'better'), ...f('superlative', 'best')],
    },
    {
      lemma: 'bad',
      pos: 'adj',
      forms: [...f('comparative', 'worse'), ...f('superlative', 'worst')],
    },
    {
      lemma: 'far',
      pos: 'adj',
      forms: [
        ...f('comparative', 'farther', 'further'),
        ...f('superlative', 'farthest', 'furthest'),
      ],
    },
  ],
};

/**
 * The lemmas the dump must NOT contribute inflections for (their paradigm is
 * curated above). Used by the Kaikki ingester.
 * @param {string} lang
 * @returns {Set<string>}
 */
export function curatedLemmas(lang) {
  return new Set((CURATED[lang] || []).map((p) => p.lemma));
}

/**
 * Write the curated paradigms into the KB, replacing whatever the dump left on
 * those lemmas. Idempotent: run it after every ingest.
 * @param {import('better-sqlite3').Database} db
 * @param {string} lang
 * @returns {{ paradigms: number, forms: number }}
 */
export function seedCurated(db, lang) {
  const paradigms = CURATED[lang] || [];
  if (!paradigms.length) return { paradigms: 0, forms: 0 };

  // A curated lemma always has a dictionary entry to hang off (the dump has all of
  // them), but create a bare one if a language's dump ever misses it — otherwise
  // the paradigm would be invisible to `formOf`'s JOIN on entries.
  const ensureEntry = db.prepare(
    `INSERT INTO entries (id, lang, word, pos, schema_version) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(id) DO NOTHING`,
  );
  const clear = db.prepare('DELETE FROM inflections WHERE entry_id = ? AND pos = ?');
  const insert = db.prepare(
    'INSERT OR REPLACE INTO inflections (entry_id, pos, tag, form, curated) VALUES (?, ?, ?, ?, 1)',
  );

  let forms = 0;
  const seed = db.transaction(() => {
    for (const p of paradigms) {
      const id = `${lang}:${p.lemma}`;
      ensureEntry.run(id, lang, p.lemma, JSON.stringify([p.pos]));
      clear.run(id, p.pos); // drop the dump's junk for this paradigm
      for (const { tag, form } of p.forms) {
        insert.run(id, p.pos, tag, form);
        forms += 1;
      }
    }
  });
  seed();
  return { paradigms: paradigms.length, forms };
}
