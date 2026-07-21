// Native-Wiktionary provider: a MONOLINGUAL definition in the book's own language.
//
// freedictionaryapi.com (freeDict.js) is English Wiktionary, so it glosses a foreign
// word in English ("huérfano → orphan") — useless to a reader who wants to understand
// the word IN that language. Each Wiktionary edition, however, defines its own words
// in its own language, and its MediaWiki API is CORS-open (`origin=*`). So for a book
// in Spanish we ask `es.wiktionary.org` and get "huérfano → Dicho de un infante, que
// ha perdido uno o ambos progenitores." — the real same-language definition.
//
// It sits in the quick chain BEFORE freeDict, so a supported non-English book prefers
// the native definition and only falls through to the English gloss when this misses.
//
// Scope: the plain-text `extracts` layout the parser reads is validated for SPANISH
// (`es`). Other editions (pt/fr/de/it/ko) render definitions differently and each
// needs its own parser — until then they keep falling through to freeDict. The
// durable, all-language answer is a Wiktextract dump ingested into the home-server KB
// (see docs/vision.md); this client provider is the offline-of-home, Spanish-first
// stopgap the user asked for.

import { getReadingLang } from '../settings.js';

const TIMEOUT = 4000; // ms — public API; never stall a word tap on it
const MAX_SYNONYMS = 8;

// Reading languages with a validated parser. `section` matches the language's own
// section header in that edition's plain-text extract (its endonym).
const SUPPORTED = {
  es: { host: 'es.wiktionary.org', section: /español/i },
};

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Pull the plain-text article extract from a Wiktionary edition's MediaWiki API.
// `origin=*` opts into anonymous CORS so the browser/WebView can call it directly.
async function fetchExtract(host, word) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    titles: word,
    prop: 'extracts',
    explaintext: '1',
    exsectionformat: 'wiki', // keeps the "== Section ==" markers the parser needs
    redirects: '1',
    origin: '*',
  });
  const res = await fetchWithTimeout(`https://${host}/w/api.php?${params}`);
  if (!res.ok) return '';
  const data = await res.json();
  const pages = data?.query?.pages;
  if (!pages) return '';
  const page = Object.values(pages)[0];
  return page?.extract || '';
}

// Clean one synonym token: drop a trailing "(Región)" qualifier and stray periods.
function cleanSynonym(s) {
  return s.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[.;]+$/, '').trim();
}

/**
 * Parse the first sense out of a Wiktionary extract, scoped to the reading
 * language's own section. The extract lays each sense out as a bare number line
 * ("1") followed by the definition text, under a "==== <Part of speech> ===="
 * header, with "Sinónimo:" lines attached to the sense.
 * @returns {{ definition: string, pos: string | null, synonyms: string[] } | null}
 */
function parseExtract(text, sectionRe) {
  const lines = text.split('\n');

  // Isolate the reading-language section (== Español ==) from any other languages
  // the page documents (the same spelling can be a word in several languages).
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^==\s*([^=].*?)\s*==$/);
    if (!m) continue;
    if (sectionRe.test(m[1])) start = i;
    else if (start >= 0) {
      end = i;
      break;
    }
  }
  if (start < 0) return null;
  const sec = lines.slice(start, end);

  // First sense: the earliest bare-number line, its following text line the
  // definition, and the part-of-speech header (====…====) it sits under.
  let curPos = null;
  let defAt = -1;
  let definition = null;
  let pos = null;
  for (let i = 0; i < sec.length; i++) {
    const h = sec[i].match(/^====\s*(.+?)\s*====$/);
    if (h) {
      curPos = h[1];
      continue;
    }
    if (/^\d+\.?$/.test(sec[i].trim())) {
      for (let j = i + 1; j < sec.length; j++) {
        const t = sec[j].trim();
        if (t) {
          definition = t;
          pos = curPos;
          defAt = i;
          break;
        }
      }
      break;
    }
  }
  if (!definition) return null;

  // Synonyms belonging to THAT sense: the "Sinónimo(s):" lines between this
  // definition and the next numbered sense.
  const synonyms = [];
  for (let i = defAt + 1; i < sec.length; i++) {
    if (/^\d+\.?$/.test(sec[i].trim())) break; // next sense
    const ms = sec[i].trim().match(/^Sin[oó]nimos?:\s*(.+)$/);
    if (!ms) continue;
    for (const part of ms[1].split(',')) {
      const s = cleanSynonym(part);
      if (s && !synonyms.includes(s)) synonyms.push(s);
      if (synonyms.length >= MAX_SYNONYMS) break;
    }
  }

  return { definition, pos, synonyms };
}

/**
 * @param {string} word normalized word
 * @returns {Promise<import('./index.js').Definition | null>}
 */
export async function lookupNativeWiktionary(word) {
  const edition = SUPPORTED[getReadingLang()];
  if (!edition) return null; // language has no validated parser — let freeDict answer

  let text;
  try {
    text = await fetchExtract(edition.host, word);
  } catch {
    return null; // timeout / offline — chain continues
  }
  if (!text) return null;

  const parsed = parseExtract(text, edition.section);
  if (!parsed) return null;

  return {
    explanation: parsed.definition,
    source: 'wiktionary',
    kb: {
      pos: parsed.pos ? [parsed.pos] : [],
      synonyms: parsed.synonyms,
      antonyms: [],
    },
  };
}
