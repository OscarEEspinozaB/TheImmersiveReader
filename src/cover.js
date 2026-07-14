// Book covers: preparing an uploaded image, and deciding which image a book opens
// with.
//
// A cover has an ORIGIN. Until now there was no such concept — the shelf simply
// showed `images[0]`, the document's first illustration — so there was no way to
// replace it and no way to get it back. A book's cover is now either:
//
//   'document' — the image the file itself opens with (the default, as before)
//   'uploaded' — one the reader chose, which replaces it
//
// Keeping the origin is what makes the swap reversible: the document's own images
// are never modified, so "use the document's image" is always one click away.

const MAX_SIDE = 1200; // px — a cover never needs more, and a phone photo is 4-8 MB
const QUALITY = 0.85;

// How far into the text an image still counts as the book's OPENING image. A cover
// sits at offset 0; an illustration in chapter 3 does not. Only an opening image is
// replaced by an uploaded cover — a mid-book illustration keeps its place in the
// text, because taking it out would be silently deleting content from the book.
const OPENING_ZONE = 200; // characters

/**
 * Is this one of the document's images the book visually opens with?
 * @param {{ start: number }} img
 */
export function isOpeningImage(img) {
  return Number(img?.start ?? Infinity) <= OPENING_ZONE;
}

/**
 * The document's own opening image, if it has one — what "use the document's image"
 * restores, and what tells the shelf whether that option is worth offering.
 * @param {{ start: number, blob: Blob }[]} [images]
 */
export function documentCover(images) {
  return (images || []).find(isOpeningImage) || null;
}

/**
 * Scale an uploaded image down to a cover: at most MAX_SIDE on its long edge, WebP
 * where the browser supports it. The original file is never stored — it would be
 * carried, at full size, inside every `.tir` the book is exported or uploaded as.
 * @param {File|Blob} file
 * @returns {Promise<{ blob: Blob, width: number, height: number }>}
 */
export async function prepareCover(file) {
  if (!file || !String(file.type || '').startsWith('image/')) {
    throw new Error('That file is not an image.');
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/webp', QUALITY);
  });
  // toBlob returns null when the type is unsupported — fall back to JPEG.
  if (blob) return { blob, width, height };
  const jpeg = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/jpeg', QUALITY);
  });
  if (!jpeg) throw new Error('Could not read that image.');
  return { blob: jpeg, width, height };
}

/**
 * The images the reader should render for a book: the book's own, with an uploaded
 * cover put in front of them (anchored at offset 0, so the existing image-anchoring
 * in reader/render.js shows it before the first word — no special case in the
 * reader). The document's opening image steps aside for it; anything deeper in the
 * text is left exactly where the author put it.
 * @param {{ cover?: Blob | null, coverSource?: string, coverWidth?: number, coverHeight?: number }} book
 * @param {{ start: number, blob: Blob }[]} [images] the document's images
 */
export function imagesWithCover(book, images = []) {
  if (book?.coverSource !== 'uploaded' || !book.cover) return images;
  return [
    { start: 0, blob: book.cover, width: book.coverWidth, height: book.coverHeight },
    ...images.filter((img) => !isOpeningImage(img)),
  ];
}
