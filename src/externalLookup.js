// External lookup links: a fallback for when neither the dictionary nor the AI
// can explain a word. These open a more powerful online dictionary or a web
// search in a new tab.
//
// Note: a web page cannot detect or use the browser's default search engine, so
// we offer explicit destinations. A preferred engine could be stored later.

/**
 * Learner-friendly dictionaries first (simpler definitions, ideal for learning),
 * then a web search as a catch-all.
 * @param {string} word the (normalized) word to look up
 * @returns {{ label: string, url: string }[]}
 */
export function buildExternalLinks(word) {
  const w = encodeURIComponent(word);
  const query = encodeURIComponent(`define ${word}`);
  return [
    { label: 'Cambridge', url: `https://dictionary.cambridge.org/dictionary/english/${w}` },
    { label: 'Oxford', url: `https://www.oxfordlearnersdictionaries.com/definition/english/${w}` },
    { label: 'DuckDuckGo', url: `https://duckduckgo.com/?q=${query}` },
    { label: 'Google', url: `https://www.google.com/search?q=${query}` },
  ];
}
