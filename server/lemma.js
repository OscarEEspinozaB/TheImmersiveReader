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
  return { lemma: best.lemma, tags: [...best.tags] };
}
