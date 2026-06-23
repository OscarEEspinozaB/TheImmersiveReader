// Free dictionary API provider: dictionaryapi.dev (no API key required).
//
// Returns a generic English definition. It is not context-aware or simplified —
// that is what the Ollama provider is for — but it works offline-of-AI and from
// any device with internet access.

import { getReadingLang } from '../settings.js';

const ENDPOINT = 'https://api.dictionaryapi.dev/api/v2/entries/';

/**
 * @param {string} word normalized word
 * @returns {Promise<import('./index.js').Definition | null>}
 */
export async function lookupDictionaryApi(word) {
  const res = await fetch(`${ENDPOINT}${getReadingLang()}/${encodeURIComponent(word)}`);
  if (!res.ok) return null; // 404 = word not found
  const data = await res.json();
  const definition = data?.[0]?.meanings?.[0]?.definitions?.[0]?.definition;
  if (!definition) return null;
  return { explanation: definition, source: 'dictionary' };
}
