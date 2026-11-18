// Reading the clipboard (writing lives in copy.js). The Android WebView refuses
// navigator.clipboard.readText() — it has no permission prompt to grant it — which
// made the editor's Paste button useless on the phone. On native, the official
// @capacitor/clipboard plugin reads it directly; the web API is the fallback (and
// what an older APK without the plugin still gets — it then fails as before, and
// the caller explains the long-press paste).

import { Clipboard } from '@capacitor/clipboard';

const NATIVE = !!globalThis.Capacitor?.isNativePlatform?.();

/**
 * The clipboard's text ('' when it holds none). Throws when it cannot be read.
 * @returns {Promise<string>}
 */
export async function readClipboardText() {
  if (NATIVE) {
    try {
      const { type, value } = await Clipboard.read();
      if (type && !String(type).startsWith('text')) return '';
      return typeof value === 'string' ? value : '';
    } catch (err) {
      // An empty clipboard also rejects here; an APK built before the plugin
      // existed rejects with "not implemented". Either way, try the web API.
      if (/empty|no data/i.test(err?.message || '')) return '';
    }
  }
  return navigator.clipboard.readText();
}

/**
 * Whether the clipboard can be read without the browser asking for permission —
 * true on the phone (native plugin). Used to PRE-FILL a field from it, which must
 * never pop a permission prompt the reader did not ask for.
 */
export function canReadClipboardQuietly() {
  return NATIVE;
}
