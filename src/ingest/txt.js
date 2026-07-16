// Plain text reader: the simplest source — read the file as-is.

/**
 * @param {File} file
 * @returns {Promise<import('./index.js').IngestResult>}
 */
export async function readTxt(file) {
  return { text: await file.text(), images: [], blocks: [] };
}
