// Word normalization — the single source of truth for turning a surface word into
// its vocabulary/dictionary key. Deliberately DEPENDENCY-FREE so it can be imported
// from both the browser frontend AND the Node LAN dictionary service (server/),
// which must key its SQLite entries with the exact same `${lang}:${word}` rule.
// (vocabulary.js re-exports these; importing vocabulary.js in Node would crash
// because it transitively loads settings.js, which touches localStorage at module
// load time.)

const TRIM_EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
// Curly/typographic apostrophes that EPUB and PDF sources often use instead of
// the plain ASCII apostrophe. Normalizing early means all downstream regexes
// (POSSESSIVE_S, contraction table keys, etc.) only need to handle U+0027.
//   U+2018  ‘  LEFT SINGLE QUOTATION MARK
//   U+2019  ’  RIGHT SINGLE QUOTATION MARK
//   U+02BC  ʼ  MODIFIER LETTER APOSTROPHE
const CURLY_APOS = /[‘’ʼ]/g;
// Possessive ’s suffix: "Dursley’s" → "dursley", "Harry’s" → "harry".
// "he’s"→"he", "it’s"→"it" are acceptable conflations for vocabulary learning.
const POSSESSIVE_S = /'s$/; // U+0027 straight apostrophe + s at end

/**
 * Canonical surface form: lowercase, curly apostrophes → straight, edges
 * trimmed, but the apostrophe is KEPT. This is the key used to look a word up in
 * the contraction registry ("didn't", "you'd", "it's" stay intact).
 * @param {string} word
 * @returns {string}
 */
export function normalizeSurface(word) {
  return word
    .toLowerCase()
    .normalize('NFC')
    .replace(CURLY_APOS, "'")
    .replace(TRIM_EDGES, '');
}

/**
 * Normalize a surface word into its vocabulary key (a single lemma). Same as
 * {@link normalizeSurface} but also strips a trailing possessive 's
 * ("Dursley's" → "dursley"). Contractions are handled separately (they map to
 * several lemmas, not one) — see contractions.js — so this is only the key for
 * ordinary words and possessives.
 * @param {string} word
 * @returns {string}
 */
export function normalize(word) {
  return normalizeSurface(word).replace(POSSESSIVE_S, '');
}
