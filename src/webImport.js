// Import a web page as a NOTE: the article's text — no ads, no menus, no comments —
// plus its main pictures, saved to read (and listen to) offline.
//
//   Wikipedia  → the REST API's clean article HTML (CORS-open, so it works on the
//                web and the phone with no server), tidied by cleanWikipedia(); the
//                note's language is the wiki's own (es.wikipedia → es).
//   any page   → Mozilla's Readability (Firefox's reader view) finds the article;
//                the language is the page's <html lang>.
//
// Both become Markdown (ingest/htmlToMarkdown.js) — the note's editable source —
// and the pictures it cites are downloaded here, keyed by src, for library.js to
// anchor. Nothing in this module is a dependency of reading: it only runs when the
// reader asks to import a link.
//
// Getting the HTML: a browser may only read another site's page when that site
// allows it (CORS). On the phone the APK fetches natively (CapacitorHttp, part of
// the installed app — no CORS); on the web, a page that refuses is fetched through
// the home server's thin /fetch proxy when one is set. Wikipedia never needs either.

import { CapacitorHttp } from '@capacitor/core';
import { htmlToMarkdown, cleanWikipedia } from './ingest/htmlToMarkdown.js';
import { prepareCover } from './cover.js';
import { READING_LANGUAGES, getKbUrl } from './settings.js';
import { logDiag } from './diagnostics.js';

const NATIVE = !!globalThis.Capacitor?.isNativePlatform?.();
const MAX_IMAGES = 8;
const MIN_TEXT = 200; // less than this and there was no article to find
const MIN_IMAGE_SIDE = 120;

/**
 * @typedef {{ title: string, markdown: string, lang: string | null, url: string,
 *   images: Map<string, { blob: Blob, width: number, height: number }> }} ImportedPage
 */

/**
 * Turn what the reader pasted (a bare address, or a shared text containing one)
 * into a URL to import.
 * @param {string} input
 * @returns {URL}
 */
export function parseLink(input) {
  const raw = String(input || '').trim();
  const found = raw.match(/https?:\/\/[^\s<>"']+/i)?.[0] || raw.split(/\s+/)[0] || '';
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(found) ? found : `https://${found}`);
  if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) {
    throw new Error('That does not look like a web address.');
  }
  url.hash = '';
  return url;
}

/**
 * Fetch and extract a page.
 * @param {string} input what the reader pasted
 * @param {{ onProgress?: (message: string) => void }} [opts]
 * @returns {Promise<ImportedPage>}
 */
export async function importFromUrl(input, { onProgress = () => {} } = {}) {
  const url = parseLink(input);
  onProgress(`Reading ${url.hostname}…`);
  const wiki = wikipediaArticle(url);
  const page = wiki ? await fromWikipedia(wiki) : await fromWebPage(url);
  if (page.markdown.replace(/\s+/g, ' ').length < MIN_TEXT) {
    throw new Error('No article text was found on that page.');
  }
  const images = new Map();
  if (page.images.length) {
    onProgress(`Saving ${page.images.length} ${page.images.length === 1 ? 'picture' : 'pictures'}…`);
    await Promise.all(
      page.images.map(async ({ src }) => {
        const img = await downloadImage(src);
        if (img) images.set(src, img);
      }),
    );
  }
  logDiag('import', `${url.hostname}: ${page.markdown.length} chars, ${images.size}/${page.images.length} pictures`);
  return { title: page.title, markdown: page.markdown, lang: page.lang, url: url.href, images };
}

// --- Wikipedia ----------------------------------------------------------------------

/** { lang, title } for a Wikipedia article URL (desktop or mobile), else null. */
function wikipediaArticle(url) {
  const host = url.hostname.match(/^([a-z][a-z-]*)\.(?:m\.)?wikipedia\.org$/i);
  if (!host) return null;
  let title = url.pathname.match(/^\/wiki\/(.+)$/)?.[1];
  if (!title && url.pathname.startsWith('/w/index.php')) title = url.searchParams.get('title');
  if (!title) return null;
  try {
    title = decodeURIComponent(title);
  } catch {
    // already decoded
  }
  return { lang: host[1].toLowerCase(), title: title.replace(/ /g, '_') };
}

async function fromWikipedia({ lang, title }) {
  const base = `https://${lang}.wikipedia.org`;
  const t = encodeURIComponent(title);
  let html;
  try {
    html = await fetchText(`${base}/api/rest_v1/page/html/${t}`, { corsOpen: true });
  } catch {
    html = await fetchText(`${base}/w/rest.php/v1/page/${t}/html`, { corsOpen: true });
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  cleanWikipedia(doc);
  const { markdown, images } = htmlToMarkdown(doc.body, { baseUrl: `${base}/wiki/`, maxImages: MAX_IMAGES });
  return {
    title: doc.title?.trim() || title.replace(/_/g, ' '),
    markdown,
    images,
    lang: readingLang(lang === 'simple' ? 'en' : lang),
  };
}

// --- Any other page -------------------------------------------------------------------

async function fromWebPage(url) {
  const html = await fetchText(url.href);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Relative links and images must resolve against the page, not this app.
  const baseEl = doc.createElement('base');
  baseEl.href = url.href;
  doc.head.prepend(baseEl);
  const pageLang = doc.documentElement.getAttribute('lang') || '';
  // Read before Readability, which rewrites the document it is given.
  const h1 = doc.querySelector('h1')?.textContent.replace(/\s+/g, ' ').trim() || '';
  removeClutter(doc);
  const { Readability } = await import('@mozilla/readability');
  const article = new Readability(doc, { charThreshold: 250 }).parse();
  if (!article?.content) throw new Error('No article was found on that page.');
  const body = new DOMParser().parseFromString(article.content, 'text/html').body;
  const { markdown, images } = htmlToMarkdown(body, { baseUrl: url.href, maxImages: MAX_IMAGES });
  return {
    title: articleTitle(article.title, h1, article.siteName) || url.hostname,
    markdown,
    images,
    lang: readingLang(article.lang || pageLang),
  };
}

// Blocks that are never the article — newsletter boxes, share bars, ads, cookie
// banners, "recommended" rails — removed by their class/id before Readability runs:
// a short call to action ending in a period can otherwise pass its text test.
const CLUTTER =
  /(^|[-_\s])(newsletter|subscribe|subscription|signup|sign-up|promo|advert|advertisement|ads?|ad-banner|banner-ad|sponsored|cookie|cookies|consent|gdpr|paywall|social|share|sharing|related|recommended|outbrain|taboola)([-_\s]|$)/i;

function removeClutter(doc) {
  for (const el of [...doc.body.querySelectorAll('[class], [id]')]) {
    if (!el.isConnected || ['ARTICLE', 'MAIN', 'BODY'].includes(el.tagName)) continue;
    if (!CLUTTER.test(`${el.getAttribute('class') || ''} ${el.id || ''}`)) continue;
    // A block with a lot of prose and few links is content, whatever its class says
    // ("article social-enabled"); clutter is short, or mostly links.
    const text = el.textContent.length;
    const links = [...el.querySelectorAll('a')].reduce((n, a) => n + a.textContent.length, 0);
    if (text > 600 && links / text < 0.5) continue;
    el.remove();
  }
}

// The page's <title> usually carries the site's name ("Story | Site"): prefer the
// article's own <h1> when the title contains it, else drop a trailing site name.
function articleTitle(title, h1, siteName) {
  const t = (title || '').replace(/\s+/g, ' ').trim();
  if (h1 && h1.length >= 6 && t.includes(h1)) return h1;
  const parts = t.split(/\s+[|–—·:-]\s+/);
  if (parts.length > 1) {
    const last = parts[parts.length - 1].toLowerCase();
    if (!siteName || last === siteName.toLowerCase() || parts[0].length >= 12) return parts.slice(0, -1).join(' – ');
  }
  return t || h1;
}

/** A page/wiki language → the app's reading-language code, or null when unsupported. */
function readingLang(code) {
  const base = String(code || '').toLowerCase().split(/[-_]/)[0];
  if (!base) return null;
  if (base === 'pt') return 'pt-BR';
  return READING_LANGUAGES.some((l) => l.code === base) ? base : null;
}

// --- Fetching -------------------------------------------------------------------------

/**
 * A page's HTML, by whichever road is open: the phone's native HTTP (no CORS), the
 * browser's own fetch (CORS-open sites), then the home server's /fetch proxy.
 */
async function fetchText(url, { corsOpen = false } = {}) {
  const reasons = [];
  const viaFetch = async () => {
    try {
      const r = await fetch(url, { credentials: 'omit' });
      if (r.ok) return await r.text();
      reasons.push(`HTTP ${r.status}`);
    } catch {
      reasons.push('the site does not allow reading it from the browser');
    }
    return null;
  };
  if (corsOpen) {
    const t = await viaFetch();
    if (t != null) return t;
  }
  if (NATIVE) {
    try {
      const r = await CapacitorHttp.get({ url, responseType: 'text', connectTimeout: 15000, readTimeout: 30000 });
      if (r.status >= 200 && r.status < 300) return typeof r.data === 'string' ? r.data : String(r.data ?? '');
      reasons.push(`HTTP ${r.status}`);
    } catch (err) {
      reasons.push(err?.message || 'native request failed');
    }
  }
  if (!corsOpen && !NATIVE) {
    const t = await viaFetch();
    if (t != null) return t;
  }
  const proxied = await viaProxy(url, 'text', reasons);
  if (proxied != null) return proxied;
  logDiag('import', `could not fetch ${url}: ${reasons.join('; ')}`);
  throw new Error(reasons[reasons.length - 1] || 'the page could not be downloaded');
}

async function viaProxy(url, kind, reasons) {
  const server = getKbUrl();
  if (!server) {
    if (!NATIVE) reasons.push('the site does not allow reading it from the browser, and no home server is set');
    return null;
  }
  try {
    const r = await fetch(`${server}/fetch?url=${encodeURIComponent(url)}`);
    if (r.ok) return kind === 'blob' ? await r.blob() : await r.text();
    reasons.push(`home server: HTTP ${r.status}`);
  } catch {
    reasons.push('the home server is unreachable');
  }
  return null;
}

async function fetchBlob(url) {
  try {
    const r = await fetch(url, { credentials: 'omit' });
    if (r.ok) return await r.blob();
  } catch {
    // not CORS-open: try the other roads
  }
  if (NATIVE) {
    try {
      const r = await CapacitorHttp.get({ url, responseType: 'blob', connectTimeout: 15000, readTimeout: 30000 });
      if (r.status >= 200 && r.status < 300 && typeof r.data === 'string') {
        const type = headerValue(r.headers, 'content-type') || 'image/jpeg';
        return base64ToBlob(r.data, type.split(';')[0].trim());
      }
    } catch {
      // fall through to the proxy
    }
  }
  return viaProxy(url, 'blob', []);
}

/** A picture, scaled for reading (≤1200 px, WebP) — or null when it is unusable. */
async function downloadImage(src) {
  try {
    const blob = await fetchBlob(src);
    if (!blob || !String(blob.type).startsWith('image/')) return null;
    const img = await prepareCover(blob);
    if (Math.max(img.width, img.height) < MIN_IMAGE_SIDE) return null;
    return img;
  } catch {
    return null;
  }
}

function headerValue(headers, name) {
  if (!headers) return '';
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : '';
}

function base64ToBlob(b64, type) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
