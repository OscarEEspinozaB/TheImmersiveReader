// Plain text reader: the simplest source — read the file as-is.

/**
 * @param {File} file
 * @returns {Promise<{ text: string, images: [] }>}
 */
export async function readTxt(file) {
  return { text: await file.text(), images: [] };
}
