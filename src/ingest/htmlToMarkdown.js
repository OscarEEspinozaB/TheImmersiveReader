// HTML → Markdown for pages imported from the web (src/webImport.js). An imported
// page becomes a NOTE, and a note's source of truth is Markdown: it stays editable,
// and it goes through the same parser (md.js) as everything the reader writes — so
// one rendering path, and every parser improvement reaches imported pages too.
//
// The conversion keeps what reads: headings, paragraphs, (nested) lists, quotes,
// code, simple tables, emphasis, and the page's MAIN images (figures, with their
// captions) up to a cap. Links keep their text only — the URL is not reading.
// Text is escaped so a stray "*" or "_" in prose can never turn into formatting.
//
// cleanWikipedia() prepares a Wikipedia (Parsoid) article first: references,
// navigation boxes, hatnotes and the trailing reference sections go; the infobox's
// image becomes the article's opening figure.

const TEXT = 3;
const ELEMENT = 1;

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'dd', 'details', 'div', 'dl',
  'dt', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary',
  'table', 'ul',
]);
const SKIP = new Set([
  'script', 'style', 'noscript', 'template', 'button', 'input', 'select', 'textarea',
  'svg', 'canvas', 'iframe', 'object', 'embed', 'video', 'audio', 'map', 'link', 'meta',
]);
const MIN_IMAGE_SIDE = 120; // smaller is an icon, a flag, a logo — not a picture
const MAX_TABLE_ROWS = 40; // a bigger table is a list to look up, not to read

/**
 * @param {Element} root the article's content
 * @param {{ baseUrl: string, maxImages?: number }} opts
 * @returns {{ markdown: string, images: { src: string }[] }}
 *   `images`: the figures kept, in order (their `src` is what the Markdown cites).
 */
export function htmlToMarkdown(root, { baseUrl, maxImages = 8 }) {
  const ctx = { baseUrl, maxImages, images: [] };
  const blocks = blockChildren(root, ctx).filter(Boolean);
  return { markdown: blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim(), images: ctx.images };
}

// --- Blocks -------------------------------------------------------------------------

function isBlock(node) {
  return node.nodeType === ELEMENT && BLOCK.has(node.localName);
}

function blockChildren(el, ctx) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length) out.push(...inlineRun(run, ctx));
    run = [];
  };
  for (const node of el.childNodes) {
    if (node.nodeType === TEXT) {
      run.push(node);
    } else if (node.nodeType === ELEMENT && !SKIP.has(node.localName)) {
      if (isBlock(node)) {
        flush();
        out.push(...blockOf(node, ctx));
      } else {
        run.push(node);
      }
    }
  }
  flush();
  return out;
}

// A run of inline content between blocks: a paragraph — or, when it holds nothing
// but images, those images as figures.
function inlineRun(all, ctx) {
  // Only text and elements carry content (comments, processing instructions do not).
  const nodes = all.filter(
    (n) => n.nodeType === TEXT || (n.nodeType === ELEMENT && !SKIP.has(n.localName)),
  );
  const imgs = [];
  let onlyImages = true;
  for (const n of nodes) {
    if (n.nodeType === TEXT) {
      if (n.data.trim()) onlyImages = false;
      continue;
    }
    const found = n.localName === 'img' ? [n] : [...n.querySelectorAll('img')];
    if (found.length && !n.textContent.trim()) imgs.push(...found);
    else onlyImages = false;
  }
  if (onlyImages && imgs.length) return imgs.map((img) => image(img, '', ctx)).filter(Boolean);
  const p = paragraph(nodes.map((n) => inline(n, ctx)).join(''));
  return p ? [p] : [];
}

function blockOf(el, ctx) {
  const tag = el.localName;
  if (/^h[1-6]$/.test(tag)) {
    const text = clean(inlineChildren(el, ctx));
    return text ? [`${'#'.repeat(Number(tag[1]))} ${text}`] : [];
  }
  switch (tag) {
    case 'p': {
      // A paragraph holding only an image is a figure.
      const p = inlineRun([...el.childNodes], ctx);
      return p;
    }
    case 'ul':
    case 'ol':
      return [list(el, ctx, 0).join('\n')].filter(Boolean);
    case 'blockquote': {
      const inner = blockChildren(el, ctx).filter(Boolean);
      return inner.length ? [inner.join('\n').split('\n').map((l) => `> ${l}`).join('\n')] : [];
    }
    case 'pre': {
      const code = el.textContent.replace(/\n+$/, '');
      if (!code.trim()) return [];
      const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1));
      return [`${fence}\n${code}\n${fence}`];
    }
    case 'figure': {
      const img = el.querySelector('img');
      const caption = el.querySelector('figcaption');
      const captionText = caption ? clean(inlineChildren(caption, ctx)) : '';
      if (img) {
        const fig = image(img, captionText, ctx);
        if (fig) return [fig];
      }
      // No usable image: the caption alone would float without its picture.
      return el.querySelector('table, pre, blockquote') ? blockChildren(el, ctx) : [];
    }
    case 'table':
      return table(el, ctx);
    case 'hr':
      return ['---'];
    case 'dt': {
      const term = clean(inlineChildren(el, ctx));
      return term ? [`**${term}**`] : [];
    }
    case 'li':
      return [paragraph(inlineChildren(el, ctx))].filter(Boolean);
    case 'figcaption':
      return []; // handled with its figure
    default:
      return blockChildren(el, ctx);
  }
}

function list(el, ctx, depth) {
  const ordered = el.localName === 'ol';
  let n = Number(el.getAttribute('start')) || 1;
  const lines = [];
  for (const li of el.children) {
    if (li.localName !== 'li') continue;
    const parts = [];
    const nested = [];
    for (const child of li.childNodes) {
      if (child.nodeType === ELEMENT && (child.localName === 'ul' || child.localName === 'ol')) {
        nested.push(...list(child, ctx, depth + 1));
      } else if (child.nodeType === ELEMENT && isBlock(child)) {
        parts.push(` ${inlineChildren(child, ctx)} `);
      } else {
        parts.push(inline(child, ctx));
      }
    }
    const text = clean(parts.join(''));
    const marker = ordered ? `${n}. ` : '- ';
    n += 1;
    if (text) lines.push(`${'  '.repeat(depth)}${marker}${text}`);
    lines.push(...nested);
  }
  return lines;
}

function table(el, ctx) {
  const rows = [...el.querySelectorAll('tr')].filter((tr) => tr.closest('table') === el);
  if (!rows.length || rows.length > MAX_TABLE_ROWS) return [];
  const cells = rows.map((tr) =>
    [...tr.children]
      .filter((c) => c.localName === 'td' || c.localName === 'th')
      .map((c) => clean(inlineChildren(c, ctx)).replace(/\|/g, '\\|')),
  );
  const width = Math.max(...cells.map((r) => r.length));
  if (width === 0) return [];
  if (cells.length === 1 || width === 1) {
    // Not a grid: one line per row.
    return cells.map((r) => paragraph(r.filter(Boolean).join(' · '))).filter(Boolean);
  }
  const pad = (r) => [...r, ...Array(width - r.length).fill('')];
  const line = (r) => `| ${pad(r).join(' | ')} |`;
  return [[line(cells[0]), `|${' --- |'.repeat(width)}`, ...cells.slice(1).map(line)].join('\n')];
}

// A figure: `![caption](src)` on its own line (md.js anchors the picture there and
// shows the caption under it). Over the cap, too small or unloadable → caption only
// would float alone, so nothing.
function image(img, caption, ctx) {
  if (ctx.images.length >= ctx.maxImages) return null;
  const src = bestSrc(img, ctx.baseUrl);
  if (!src || tooSmall(img)) return null;
  ctx.images.push({ src });
  const alt = (caption || img.getAttribute('alt') || '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
  return `![${alt}](${src.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20')})`;
}

function tooSmall(img) {
  const n = (a) => Number(img.getAttribute(a)) || 0;
  const w = n('data-file-width') || n('width');
  const h = n('data-file-height') || n('height');
  return (w && w < MIN_IMAGE_SIDE) || (h && h < MIN_IMAGE_SIDE);
}

// The largest candidate: srcset's biggest descriptor, a lazy-loading attribute, or src.
function bestSrc(img, baseUrl) {
  let best = null;
  let bestScore = -1;
  const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
  for (const part of srcset.split(',')) {
    const [u, d] = part.trim().split(/\s+/);
    if (!u) continue;
    const score = d ? parseFloat(d) * (d.endsWith('w') ? 1 : 1000) : 1;
    if (score > bestScore) {
      best = u;
      bestScore = score;
    }
  }
  const raw = best || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('src');
  if (!raw || raw.startsWith('data:')) return null;
  try {
    const u = new URL(raw, baseUrl);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

// --- Inline -------------------------------------------------------------------------

function inlineChildren(el, ctx) {
  return [...el.childNodes].map((n) => inline(n, ctx)).join('');
}

function inline(node, ctx) {
  if (node.nodeType === TEXT) return escapeText(node.data.replace(/\s+/g, ' '));
  if (node.nodeType !== ELEMENT || SKIP.has(node.localName)) return '';
  switch (node.localName) {
    case 'br':
      return ' ';
    case 'img':
      return ''; // an inline picture (an icon in a sentence) is not reading
    case 'strong':
    case 'b':
      return wrap(inlineChildren(node, ctx), '**');
    case 'em':
    case 'i':
    case 'cite':
    case 'dfn':
    case 'var':
      return wrap(inlineChildren(node, ctx), '*');
    case 's':
    case 'del':
    case 'strike':
      return wrap(inlineChildren(node, ctx), '~~');
    case 'code':
    case 'kbd':
    case 'samp':
    case 'tt':
      return codeSpan(node.textContent);
    case 'sup':
      // A footnote/reference marker ("[3]", "12") is not reading.
      return /^\s*\[?\s*[\d\w]{1,4}\s*\]?\s*$/.test(node.textContent) && node.querySelector('a')
        ? ''
        : inlineChildren(node, ctx);
    default:
      return inlineChildren(node, ctx);
  }
}

function wrap(inner, marker) {
  if (!inner.trim()) return inner;
  const lead = inner.match(/^\s*/)[0];
  const trail = inner.match(/\s*$/)[0];
  return `${lead}${marker}${inner.trim()}${marker}${trail}`;
}

function codeSpan(text) {
  const t = text.replace(/\s+/g, ' ');
  if (!t.trim()) return t;
  const fence = '`'.repeat(longestRun(t, '`') + 1);
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${t}${pad}${fence}`;
}

function longestRun(s, ch) {
  let best = 0;
  let cur = 0;
  for (const c of s) {
    cur = c === ch ? cur + 1 : 0;
    if (cur > best) best = cur;
  }
  return best;
}

/** Escape what md.js would read as syntax inside running text. */
function escapeText(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/([*`[\]])/g, '\\$1')
    .replace(/~~/g, '\\~\\~')
    .replace(/<(?=[A-Za-z/!])/g, '\\<')
    .replace(/&(?=#?\w+;)/g, '\\&')
    // An underscore only needs escaping where it could open/close emphasis — never
    // inside a word, so identifiers stay readable in the note's source.
    .replace(/_(?=[^\p{L}\p{N}_]|$)/gu, '\\_')
    .replace(/(^|[^\p{L}\p{N}_\\])_/gu, '$1\\_');
}

function clean(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// A paragraph's text, with a line start that md.js would read as block syntax
// (a heading, quote, list item, fence, rule) escaped.
function paragraph(s) {
  const t = clean(s);
  if (!t) return '';
  const num = t.match(/^(\d+)([.)])(\s|$)/);
  if (num) return `${num[1]}\\${t.slice(num[1].length)}`;
  if (/^(#{1,6}(\s|$)|>|[-+*](\s|$)|`{3,}|~{3,}|[-=_]{3,}\s*$|\|)/.test(t)) return `\\${t}`;
  return t;
}

// --- Wikipedia ------------------------------------------------------------------------

// Trailing sections that are apparatus, not article — by heading, in the reading
// languages the app supports.
const END_SECTIONS = new Set([
  // en
  'see also', 'notes', 'references', 'external links', 'further reading', 'bibliography',
  'sources', 'citations', 'footnotes', 'notes and references', 'works cited', 'gallery',
  // es
  'véase también', 'notas', 'referencias', 'notas y referencias', 'enlaces externos',
  'bibliografía', 'galería', 'fuentes',
  // fr
  'voir aussi', 'références', 'notes et références', 'liens externes', 'bibliographie',
  'galerie', 'articles connexes',
  // de
  'siehe auch', 'einzelnachweise', 'weblinks', 'literatur', 'anmerkungen', 'quellen',
  // it
  'note', 'bibliografia', 'collegamenti esterni', 'voci correlate', 'altri progetti',
  // pt
  'ver também', 'referências', 'ligações externas', 'notas e referências', 'galeria',
]);

const WIKI_JUNK = [
  'style', 'link', 'meta', 'script', 'noscript',
  '.navbox', '.navbox-styles', '.vertical-navbox', '.sidebar', '.hatnote', '.dablink',
  '.shortdescription', '.mw-references-wrap', 'ol.references', '.reflist', 'sup.mw-ref',
  'sup.reference', '.noprint', '.metadata', '.ambox', '.mbox-small', '.side-box',
  '.sistersitebox', '.portalbox', '.mw-empty-elt', '.gallery', '.mw-editsection',
  '#coordinates', '[role="navigation"]', '.toc',
];

/**
 * Clean a Wikipedia article (Parsoid HTML from the REST API) in place.
 * @param {Document} doc
 */
export function cleanWikipedia(doc) {
  // The infobox's picture is usually THE picture of the subject: keep it, as the
  // article's opening figure, before the infobox (and its data table) goes.
  const infobox = doc.querySelector('.infobox');
  if (infobox) {
    const img = [...infobox.querySelectorAll('img')].find((i) => !tooSmall(i));
    const lead = doc.querySelector('section[data-mw-section-id="0"]') || doc.body;
    if (img) {
      const fig = doc.createElement('figure');
      fig.appendChild(img.cloneNode(true));
      const cap = infobox.querySelector('.infobox-caption');
      if (cap?.textContent.trim()) {
        const fc = doc.createElement('figcaption');
        fc.textContent = cap.textContent.trim();
        fig.appendChild(fc);
      }
      lead.prepend(fig);
    }
    doc.querySelectorAll('.infobox').forEach((el) => el.remove());
  }
  // Math: keep the formula's TeX as code (the rendered SVG is not text).
  doc.querySelectorAll('.mwe-math-element').forEach((el) => {
    const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent
      || el.querySelector('img')?.getAttribute('alt') || '';
    const code = doc.createElement('code');
    code.textContent = tex.replace(/^\{\\displaystyle\s*/, '').replace(/\}$/, '').trim();
    el.replaceWith(code);
  });
  for (const sel of WIKI_JUNK) doc.querySelectorAll(sel).forEach((el) => el.remove());
  // Trailing apparatus sections (with their subsections — Parsoid nests them).
  doc.querySelectorAll('section').forEach((sec) => {
    const h = sec.querySelector(':scope > h2, :scope > h3');
    if (h && END_SECTIONS.has(h.textContent.trim().toLowerCase())) sec.remove();
  });
}
