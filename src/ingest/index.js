// Ingest dispatcher: pick a reader by file extension and always return the shared
// document shape — flat clean text for the tokenizer, plus structure ALONGSIDE it.
//
// The text is the single source of truth for char offsets (tokens, reading
// positions, image anchors), so structure never rewrites it: it annotates ranges.
//
//   blocks[] conventions (produced by readers, consumed by the block renderer):
//   - ranges are sorted and non-overlapping; plain paragraphs are NOT annotated;
//   - a block is separated from its neighbours by "\n\n", except consecutive
//     list items, separated by a single "\n" (a tight list);
//   - a list item's text begins with its visible marker ("• " or "3. ");
//   - a code block keeps its internal newlines and indentation verbatim.

import { readTxt } from './txt.js';
import { readMd } from './md.js';
import { readPdf } from './pdf.js';
import { readEpub } from './epub.js';

/**
 * @typedef {'h1'|'h2'|'h3'|'li'|'code'|'quote'} BlockType
 * @typedef {{ start: number, end: number, type: BlockType }} DocBlock
 * @typedef {{ start: number, width: number, height: number, blob: Blob }} DocImage
 * @typedef {{ text: string, images: DocImage[], blocks: DocBlock[] }} IngestResult
 */

/**
 * @param {File} file
 * @returns {Promise<IngestResult>}
 */
export async function ingest(file) {
  const ext = file.name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'pdf':
      return readPdf(file);
    case 'epub':
      return readEpub(file);
    case 'md':
    case 'markdown':
      return readMd(file);
    case 'txt':
    case 'text':
      return readTxt(file);
    default:
      // Fall back to treating unknown types as plain text.
      return readTxt(file);
  }
}
