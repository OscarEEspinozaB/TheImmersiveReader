// Node-side plain-text extraction from a PDF, for the batch dictionary builder.
//
// The app's browser ingester (src/ingest/pdf.js) does richer geometry-based
// paragraph reconstruction with a Vite-bundled worker; here we only need a flat
// stream of words to build the vocabulary, so we read each page's text items in
// order. Uses the pdfjs-dist legacy build, which runs under Node without a worker.

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'node:fs';

/**
 * Extract all text from a PDF file as one string (page texts joined by newlines).
 * @param {string} file absolute or relative path to the .pdf
 * @returns {Promise<string>}
 */
export async function extractPdfText(file) {
  const data = new Uint8Array(readFileSync(file));
  const doc = await getDocument({ data }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push(content.items.map((i) => i.str).join(' '));
  }
  return pages.join('\n');
}
