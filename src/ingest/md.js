// Markdown reader: Markdown is parsed line by line into the shared
// { text, images, blocks } shape (see index.js): headings, list items, fenced
// code and blockquotes become typed blocks; inline markers (emphasis, links,
// code spans) are stripped so the tokenizer sees clean prose. Fenced code used
// to be dropped as "not reading material" — in a technical book it very much is,
// so it is now kept verbatim as a code block.

/**
 * @param {File} file
 * @returns {Promise<import('./index.js').IngestResult>}
 */
export async function readMd(file) {
  return parseMarkdown(await file.text());
}

const FENCE = /^\s{0,3}(```|~~~)\s*\S*\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^\s{0,5}(?:[-*+]|(\d+)[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;

/**
 * @param {string} md
 * @returns {import('./index.js').IngestResult}
 */
export function parseMarkdown(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = {
    text: '',
    blocks: [],
    /** Append `body` as a typed block, "\n"-separated from a preceding list item. */
    push(type, body, { tight = false } = {}) {
      if (this.text !== '') {
        this.text += tight && this.lastType === 'li' ? '\n' : '\n\n';
      }
      const start = this.text.length;
      this.text += body;
      if (this.text.length > start) this.blocks.push({ start, end: this.text.length, type });
      this.lastType = type;
    },
    pushProse(body) {
      if (this.text !== '') this.text += '\n\n';
      this.text += body;
      this.lastType = null;
    },
    lastType: null,
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '' || RULE.test(line)) {
      i += 1;
      continue;
    }

    // Fenced code: kept verbatim (indentation and blank lines included).
    const fence = line.match(FENCE);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or EOF)
      const code = body.join('\n').replace(/^\n+/, '').trimEnd();
      if (code) out.push('code', code);
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      out.push(`h${level}`, stripInline(heading[2]));
      i += 1;
      continue;
    }

    // Blockquote: a run of "> " lines becomes ONE quote block, inner line breaks kept.
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(stripInline(lines[i].match(QUOTE)[1]));
        i += 1;
      }
      out.push('quote', body.join('\n').trim());
      continue;
    }

    // List item: marker normalized ("• " / the source's "3. "); indented
    // continuation lines fold into the item.
    const item = line.match(LIST_ITEM);
    if (item) {
      let body = stripInline(item[2]);
      i += 1;
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST_ITEM.test(lines[i]) && !FENCE.test(lines[i])) {
        body += ` ${stripInline(lines[i].trim())}`;
        i += 1;
      }
      const marker = item[1] ? `${item[1]}. ` : '• ';
      out.push('li', marker + body, { tight: true });
      continue;
    }

    // Prose paragraph: consecutive plain lines, soft-wrapped into one paragraph.
    const body = [];
    while (
      i < lines.length && lines[i].trim() !== '' &&
      !HEADING.test(lines[i]) && !FENCE.test(lines[i]) &&
      !QUOTE.test(lines[i]) && !LIST_ITEM.test(lines[i]) && !RULE.test(lines[i])
    ) {
      body.push(stripInline(lines[i].trim()));
      i += 1;
    }
    out.pushProse(body.join(' '));
  }

  // trimEnd only: a leading trim would shift every recorded block offset.
  return { text: out.text.trimEnd(), images: [], blocks: out.blocks };
}

/** Remove inline Markdown syntax, keeping the human-readable text. */
function stripInline(s) {
  let text = s;
  // Inline code -> keep the content without backticks.
  text = text.replace(/`([^`]+)`/g, '$1');
  // Images -> keep alt text.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Links -> keep link text.
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Emphasis / bold / strikethrough markers.
  text = text.replace(/(\*\*|__|\*|_|~~)(.*?)\1/g, '$2');
  return text;
}
