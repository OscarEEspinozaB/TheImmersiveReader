// Markdown reader: Markdown is parsed line by line into the shared
// { text, images, blocks, marks } shape (see index.js). Block structure — headings,
// list items (with their nesting level), fenced code, blockquotes, table rows,
// thematic breaks — becomes typed `blocks`; inline formatting — bold, italic, code
// spans, strikethrough — becomes `marks`. Both are char ranges over the clean text:
// the syntax is removed so the tokenizer (and the voice) see plain prose, and what
// it meant travels alongside, never inside, the text.
//
// Inline parsing follows CommonMark's delimiter rules closely enough for real-world
// text (an assistant's answer, a README): an underscore INSIDE a word is never
// emphasis (`my_config_file.py` stays whole), a `*` with spaces on both sides is a
// multiplication sign, code spans are opaque (nothing inside them is parsed),
// backslash escapes and HTML entities are honored, inline HTML tags are dropped.
//
// Tables become one block per body row, each cell on its own line as
// "Header: value" — a phone-width reading of a grid, and the natural way to say it
// aloud. Fenced code is kept verbatim (in a technical text it IS reading material).

/**
 * Bump when the parse of the same source would change — notes keep their source and
 * are re-parsed on open when they were parsed by an older version (library.js).
 */
export const MD_VERSION = 2;

/**
 * @param {File} file
 * @returns {Promise<import('./index.js').IngestResult>}
 */
export async function readMd(file) {
  return parseMarkdown(await file.text());
}

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*(?:\s#+)?\s*$/;
const SETEXT_H1 = /^\s{0,3}=+\s*$/;
const SETEXT_H2 = /^\s{0,3}-+\s*$/;
const QUOTE = /^\s{0,3}(?:>\s?)+(.*)$/;
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const LINK_DEF = /^\s{0,3}\[[^\]]+\]:\s*\S+/;
const TASK = /^\[([ xX])\]\s+/;

const BULLETS = ['•', '◦', '▪'];
// What a thematic break reads as: a quiet centered divider that has no words, so
// the voice passes over it.
const BREAK_TEXT = '· · ·';

/**
 * @param {string} md
 * @returns {import('./index.js').IngestResult}
 */
export function parseMarkdown(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = {
    text: '',
    blocks: [],
    marks: [],
    lastType: null,
    /** Separate from what came before: "\n" between list items (a tight list), else "\n\n". */
    sep(tight) {
      if (this.text !== '') this.text += tight && this.lastType === 'li' ? '\n' : '\n\n';
    },
    /** Append an inline-parsed body, shifting its marks to their place in the text. */
    append({ text, marks }) {
      const at = this.text.length;
      this.text += text;
      for (const m of marks) this.marks.push({ start: m.start + at, end: m.end + at, type: m.type });
    },
    /** Append `body` ({ text, marks }) as a typed block. */
    push(type, body, { tight = false, level = 0 } = {}) {
      if (!body.text) return;
      this.sep(tight);
      const start = this.text.length;
      this.append(body);
      const block = { start, end: this.text.length, type };
      if (level > 0) block.level = level;
      this.blocks.push(block);
      this.lastType = type;
    },
    pushProse(body) {
      if (!body.text) return;
      this.sep(false);
      this.append(body);
      this.lastType = null;
    },
  };

  // Indentation of the open list levels (a stack), so nesting survives the parse.
  let listIndents = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i += 1;
      continue;
    }
    if (LINK_DEF.test(line)) {
      i += 1; // a reference definition is not text
      continue;
    }

    // Fenced code: kept verbatim (indentation relative to the fence, blank lines
    // included). The fence may itself be indented — inside a list item, say.
    const fence = line.match(FENCE_OPEN);
    if (fence) {
      const indent = fence[1].length;
      const close = new RegExp(`^\\s*${fence[2][0] === '`' ? '`' : '~'}{${fence[2].length},}\\s*$`);
      const body = [];
      i += 1;
      while (i < lines.length && !close.test(lines[i])) {
        body.push(dedent(lines[i], indent));
        i += 1;
      }
      i += 1; // closing fence (or EOF)
      const code = body.join('\n').replace(/^\n+/, '').trimEnd();
      if (code) out.push('code', { text: code, marks: [] });
      listIndents = [];
      continue;
    }

    if (RULE.test(line)) {
      out.push('hr', { text: BREAK_TEXT, marks: [] });
      listIndents = [];
      i += 1;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      out.push(`h${level}`, inline(heading[2]));
      listIndents = [];
      i += 1;
      continue;
    }

    // Blockquote: a run of "> " lines becomes ONE quote block, inner line breaks kept.
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(lines[i].match(QUOTE)[1]);
        i += 1;
      }
      out.push('quote', inline(body.join('\n').trim()));
      listIndents = [];
      continue;
    }

    // Table: a header row, a delimiter row, then body rows.
    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]) && /[|].*-|-.*[|]/.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      let rows = 0;
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        const row = tableRow(header, splitRow(lines[i]));
        if (row.text) {
          out.push('row', row);
          rows += 1;
        }
        i += 1;
      }
      // A header with no body still says something: keep it as one line.
      if (!rows) out.push('row', joinInline(header.map(inline), ' · '));
      listIndents = [];
      continue;
    }

    // List item: marker normalized ("• " / the source's "3. " / "☐ " for a task);
    // indented continuation lines fold into the item. The nesting level comes from
    // the indentation relative to the enclosing items.
    const item = line.match(LIST_ITEM);
    if (item) {
      const indent = item[1].replace(/\t/g, '    ').length;
      while (listIndents.length && indent < listIndents[listIndents.length - 1]) listIndents.pop();
      if (!listIndents.length || indent > listIndents[listIndents.length - 1]) listIndents.push(indent);
      const level = Math.min(listIndents.length - 1, 2);

      let body = item[4];
      i += 1;
      while (
        i < lines.length && /^\s{2,}\S/.test(lines[i]) &&
        !LIST_ITEM.test(lines[i]) && !FENCE_OPEN.test(lines[i])
      ) {
        body += ` ${lines[i].trim()}`;
        i += 1;
      }
      let marker = item[3] ? `${item[3]}. ` : `${BULLETS[level]} `;
      const task = body.match(TASK);
      if (task) {
        marker = task[1] === ' ' ? '☐ ' : '☑ ';
        body = body.slice(task[0].length);
      }
      out.push('li', joinInline([{ text: marker, marks: [] }, inline(body)], ''), { tight: true, level });
      continue;
    }
    listIndents = [];

    // Prose paragraph: consecutive plain lines, soft-wrapped into one paragraph —
    // unless an "===" / "---" underline turns them into a (setext) heading.
    const body = [];
    let setext = null;
    while (
      i < lines.length && lines[i].trim() !== '' &&
      !HEADING.test(lines[i]) && !FENCE_OPEN.test(lines[i]) &&
      !QUOTE.test(lines[i]) && !LIST_ITEM.test(lines[i]) && !RULE.test(lines[i])
    ) {
      body.push(lines[i].trim());
      i += 1;
      const next = lines[i];
      if (next != null && (SETEXT_H1.test(next) || SETEXT_H2.test(next))) {
        setext = SETEXT_H1.test(next) ? 'h1' : 'h2';
        i += 1;
        break;
      }
    }
    if (setext) out.push(setext, inline(body.join(' ')));
    else out.pushProse(inline(body.join(' ')));
  }

  // trimEnd only: a leading trim would shift every recorded offset.
  return { text: out.text.trimEnd(), images: [], blocks: out.blocks, marks: out.marks };
}

function dedent(line, n) {
  let k = 0;
  while (k < n && (line[k] === ' ' || line[k] === '\t')) k += 1;
  return line.slice(k);
}

// --- Tables -------------------------------------------------------------------------

/** Cells of a table row ("| a | b |" or "a | b"), escaped pipes kept as text. */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && s[k + 1] === '|') {
      cur += '|';
      k += 1;
    } else if (s[k] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += s[k];
    }
  }
  cells.push(cur.trim());
  return cells;
}

/** One body row as "Header: value" lines, the header label in bold. */
function tableRow(header, cells) {
  const parts = [];
  for (let k = 0; k < cells.length; k++) {
    const value = inline(cells[k]);
    if (!value.text) continue;
    const label = header[k] ? inline(header[k]) : null;
    if (label?.text) {
      const lbl = joinInline([label, { text: ':', marks: [] }], '');
      lbl.marks.push({ start: 0, end: lbl.text.length, type: 'b' });
      parts.push(joinInline([lbl, value], ' '));
    } else {
      parts.push(value);
    }
  }
  return joinInline(parts, '\n');
}

/** Concatenate inline results with a separator, shifting marks. */
function joinInline(parts, sep) {
  let text = '';
  const marks = [];
  parts.forEach((p, n) => {
    if (n > 0) text += sep;
    const at = text.length;
    text += p.text;
    for (const m of p.marks) marks.push({ start: m.start + at, end: m.end + at, type: m.type });
  });
  return { text, marks };
}

// --- Inline -------------------------------------------------------------------------

const ESC = '\u0001'; // marks the next char as a literal (from a backslash escape)
const ESCAPABLE = /\\([!-/:-@[-`{-~])/g;
const CODE_SPAN = /(`+)([\s\S]*?[^`])\1(?!`)/g;
const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  times: '×', middot: '·', deg: '°', euro: '€',
};

/**
 * Parse one block's inline Markdown into clean text plus formatting ranges.
 * @param {string} src
 * @returns {{ text: string, marks: { start: number, end: number, type: 'b'|'i'|'s'|'code' }[] }}
 */
export function inline(src) {
  // 1. Code spans are opaque: split them out before anything else touches the text.
  const nodes = [];
  let last = 0;
  for (const m of src.matchAll(CODE_SPAN)) {
    // A code span next to a delimiter counts as a letter for the flanking rules,
    // so **`code`** is bold code rather than literal asterisks.
    if (m.index > last) scanText(src.slice(last, m.index), nodes, { codeBefore: last > 0, codeAfter: true });
    let code = m[2].replace(/\n/g, ' ');
    if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
    nodes.push({ kind: 'code', text: code });
    last = m.index + m[0].length;
  }
  if (last < src.length) scanText(src.slice(last), nodes, { codeBefore: last > 0, codeAfter: false });

  // 2. Emphasis: match delimiter runs (CommonMark's algorithm, simplified).
  matchDelimiters(nodes);

  // 3. Emit text and marks.
  let text = '';
  const marks = [];
  for (const n of nodes) {
    if (n.kind === 'code') {
      const start = text.length;
      text += n.text;
      if (text.length > start) marks.push({ start, end: text.length, type: 'code' });
    } else if (n.kind === 'text') {
      text += n.text;
    } else {
      // A delimiter run: closers end their marks BEFORE any literal leftovers; openers
      // put leftovers first, then start their marks.
      for (const mk of n.closes) mk.end = text.length;
      text += n.ch.repeat(n.len);
      for (const mk of n.opens) {
        mk.start = text.length;
        marks.push(mk);
      }
    }
  }
  text = text.replace(/\s+$/u, '');
  return {
    text,
    marks: marks
      .map(({ start, end, type }) => ({ start, end: Math.min(end, text.length), type }))
      .filter((m) => m.end > m.start),
  };
}

// Inline HTML that is dropped (its text kept). A whitelist, so prose like
// "List<T>" or "a <b> c" written without code marks is never eaten.
const HTML_TAG =
  /<\/?(?:a|abbr|b|big|blockquote|br|center|cite|code|dd|del|details|div|dl|dt|em|figcaption|figure|font|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|picture|pre|q|s|samp|small|source|span|strike|strong|sub|summary|sup|table|tbody|td|th|thead|tr|tt|u|ul|var)\b[^<>]*>/gi;

// Pre-clean a non-code stretch (escapes, links, images, HTML) and split it into text
// nodes and delimiter-run nodes. `codeBefore` / `codeAfter`: a code span touches the
// stretch on that side (it counts as a letter for the flanking rules).
function scanText(raw, nodes, { codeBefore = false, codeAfter = false } = {}) {
  let s = raw
    .replace(ESCAPABLE, `${ESC}$1`)
    // Images keep their alt text; links keep their text (the URL is not reading).
    .replace(/(?<!\u0001)!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(?<!\u0001)\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1')
    .replace(/(?<!\u0001)\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/(?<!\u0001)\[\^[^\]]+\]/g, '') // footnote references
    // Autolinks keep the address; HTML comments and tags go (a <br> is a space).
    .replace(/<((?:https?|ftp|mailto):[^>\s]+)>/gi, '$1')
    .replace(/<([^>\s@]+@[^>\s]+)>/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(HTML_TAG, '');
  // Markdown collapses runs of spaces (a decoded &nbsp; or <br> next to a space,
  // hard-break trailing spaces…); line breaks inside a quote are kept.
  s = decodeEntities(s).replace(/[ \t\u00a0]{2,}/g, ' ');

  let buf = '';
  const flush = () => {
    if (buf) nodes.push({ kind: 'text', text: buf });
    buf = '';
  };
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === ESC) {
      if (k + 1 < s.length) buf += s[k + 1];
      k += 1;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let run = 1;
      while (s[k + run] === c) run += 1;
      // A single "~" is "approximately", never strikethrough.
      if (c === '~' && run !== 2) {
        buf += c.repeat(run);
        k += run - 1;
        continue;
      }
      flush();
      const before = k > 0 ? s[k - 1] : codeBefore ? 'a' : undefined;
      const after = k + run < s.length ? s[k + run] : codeAfter ? 'a' : undefined;
      nodes.push({ kind: 'delim', ch: c, len: run, orig: run, before, after, opens: [], closes: [] });
      k += run - 1;
      continue;
    }
    buf += c;
  }
  flush();
}

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (all, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[name.toLowerCase()] ?? all;
  });
}

const isSpace = (c) => c == null || /\s/u.test(c);
const isPunct = (c) => c != null && /[\p{P}\p{S}]/u.test(c);

// Decide which delimiter runs can open/close (left/right-flanking rules), then pair
// closers with the nearest compatible opener.
function matchDelimiters(nodes) {
  const delims = nodes.filter((n) => n.kind === 'delim');
  for (const d of delims) {
    const { before, after } = d;
    const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
    const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
    if (d.ch === '_') {
      d.canOpen = left && (!right || isPunct(before));
      d.canClose = right && (!left || isPunct(after));
    } else {
      d.canOpen = left;
      d.canClose = right;
    }
  }
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer.canClose) continue;
    while (closer.len > 0) {
      let oi = -1;
      for (let k = ci - 1; k >= 0; k--) {
        const o = delims[k];
        if (o.ch !== closer.ch || !o.canOpen || o.len === 0) continue;
        // "Rule of 3": a run that can both open and close does not pair with one
        // whose combined length is a multiple of 3 (unless both are).
        if ((o.canClose || closer.canOpen) && (o.orig + closer.orig) % 3 === 0 &&
            !(o.orig % 3 === 0 && closer.orig % 3 === 0)) continue;
        oi = k;
        break;
      }
      if (oi < 0) break;
      const opener = delims[oi];
      const use = closer.ch === '~' ? 2 : opener.len >= 2 && closer.len >= 2 ? 2 : 1;
      const type = closer.ch === '~' ? 's' : use === 2 ? 'b' : 'i';
      const mark = { start: 0, end: 0, type };
      opener.len -= use;
      closer.len -= use;
      opener.opens.unshift(mark); // inner marks open last
      closer.closes.push(mark);
      // Delimiters between the pair can no longer match anything.
      for (let k = oi + 1; k < ci; k++) delims[k].canOpen = delims[k].canClose = false;
    }
  }
}
