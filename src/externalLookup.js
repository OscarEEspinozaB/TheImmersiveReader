// External lookup links: a fallback for when neither the dictionary nor the AI
// can explain a word. These open a more powerful online dictionary or a web
// search in a new tab.
//
// The links are scoped to the ACTIVE reading language (the open book's language):
// looking up a Spanish word should point at the RAE, not at Oxford English. Each
// language gets its own learner-friendly dictionaries first, then Wiktionary and a
// web search as universal catch-alls.
//
// Note: a web page cannot detect or use the browser's default search engine, so
// we offer explicit destinations. A preferred engine could be stored later.

import { getReadingLang } from './settings.js';

// Per-language dictionary destinations. The key is the reading-language code
// (matches READING_LANGUAGES in settings.js). Each builder takes the
// already-encoded word and returns its dictionary URL. The Wiktionary subdomain
// and the web-search hint are localized too, so the catch-alls land on the right
// language as well.
const DICTIONARIES = {
  en: {
    wiktionary: 'en',
    searchHint: 'define',
    links: (w) => [
      { label: 'Cambridge', url: `https://dictionary.cambridge.org/dictionary/english/${w}` },
      { label: 'Oxford', url: `https://www.oxfordlearnersdictionaries.com/definition/english/${w}` },
    ],
  },
  es: {
    wiktionary: 'es',
    searchHint: 'significado de',
    links: (w) => [
      { label: 'RAE', url: `https://dle.rae.es/${w}` },
      { label: 'WordReference', url: `https://www.wordreference.com/definicion/${w}` },
    ],
  },
  fr: {
    wiktionary: 'fr',
    searchHint: 'définition',
    links: (w) => [
      { label: 'Larousse', url: `https://www.larousse.fr/dictionnaires/francais/${w}` },
      { label: 'CNRTL', url: `https://www.cnrtl.fr/definition/${w}` },
    ],
  },
  de: {
    wiktionary: 'de',
    searchHint: 'Bedeutung',
    links: (w) => [
      { label: 'Duden', url: `https://www.duden.de/suchen/dudenonline/${w}` },
      { label: 'DWDS', url: `https://www.dwds.de/wb/${w}` },
    ],
  },
  it: {
    wiktionary: 'it',
    searchHint: 'significato',
    links: (w) => [
      { label: 'Treccani', url: `https://www.treccani.it/vocabolario/ricerca/${w}` },
    ],
  },
  'pt-BR': {
    wiktionary: 'pt',
    searchHint: 'significado de',
    links: (w) => [
      { label: 'Priberam', url: `https://dicionario.priberam.org/${w}` },
      { label: 'Dicio', url: `https://www.dicio.com.br/${w}` },
    ],
  },
};

/**
 * Learner-friendly dictionaries for the active reading language first (simpler
 * definitions, ideal for learning), then Wiktionary and a web search as
 * catch-alls. Falls back to English when the language has no specific entry.
 * @param {string} word the (normalized) word to look up
 * @returns {{ label: string, url: string }[]}
 */
export function buildExternalLinks(word) {
  const w = encodeURIComponent(word);
  const config = DICTIONARIES[getReadingLang()] || DICTIONARIES.en;
  const query = encodeURIComponent(`${config.searchHint} ${word}`);
  return [
    ...config.links(w),
    { label: 'Wiktionary', url: `https://${config.wiktionary}.wiktionary.org/wiki/${w}` },
    { label: 'DuckDuckGo', url: `https://duckduckgo.com/?q=${query}` },
    { label: 'Google', url: `https://www.google.com/search?q=${query}` },
  ];
}
