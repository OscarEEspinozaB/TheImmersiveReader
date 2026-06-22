// Markdown reader: Markdown is treated as plain reading text, not rendered as
// rich HTML. We strip/flatten the common formatting markers so the tokenizer
// sees clean prose.

/**
 * @param {File} file
 * @returns {Promise<{ text: string, images: [] }>}
 */
export async function readMd(file) {
  const raw = await file.text();
  return { text: flattenMarkdown(raw), images: [] };
}

/**
 * Remove Markdown syntax, keeping the human-readable text.
 * @param {string} md
 * @returns {string}
 */
export function flattenMarkdown(md) {
  let text = md;

  // Fenced code blocks -> drop entirely (not reading material).
  text = text.replace(/```[\s\S]*?```/g, '');
  // Inline code -> keep the content without backticks.
  text = text.replace(/`([^`]+)`/g, '$1');
  // Images -> keep alt text.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Links -> keep link text.
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Headings, blockquotes, list markers at line start.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '');
  // Emphasis / bold / strikethrough markers.
  text = text.replace(/(\*\*|__|\*|_|~~)(.*?)\1/g, '$2');
  // Horizontal rules.
  text = text.replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, '');

  return text;
}
