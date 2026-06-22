// Ingest dispatcher: pick a reader by file extension and always return a single
// clean text string ready for the tokenizer.

import { readTxt } from './txt.js';
import { readMd } from './md.js';
import { readPdf } from './pdf.js';

/**
 * @param {File} file
 * @returns {Promise<{ text: string, images: { start: number, width: number, height: number, blob: Blob }[] }>}
 */
export async function ingest(file) {
  const ext = file.name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'pdf':
      return readPdf(file);
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
