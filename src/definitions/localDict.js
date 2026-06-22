// Local dictionary provider (placeholder).
//
// First link in the chain: an offline, instant lookup. For now it holds no
// entries and always defers to the next provider. Later this can be backed by a
// bundled word list or a cache of previously fetched explanations.

/** @type {Map<string, string>} */
const entries = new Map();

/**
 * @param {string} word normalized word
 * @returns {Promise<import('./index.js').Definition | null>}
 */
export async function lookupLocal(word) {
  const hit = entries.get(word);
  return hit ? { explanation: hit, source: 'local' } : null;
}
