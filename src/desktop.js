// The desktop app (Tauri): the same web build in a native window (docs/desktop.md).
// A window has no tabs, so a link that asks for a new one would otherwise do nothing;
// here every such link goes to the system browser. No-op on the web and on Android.

import { openUrl } from '@tauri-apps/plugin-opener';
import { logDiagError } from './diagnostics.js';

/** True inside the desktop app; false in a browser and in the Android APK. */
export const isDesktopApp = !!globalThis.__TAURI_INTERNALS__;

function openExternal(url) {
  openUrl(String(url)).catch((err) => logDiagError('desktop', err));
}

/** Send new-tab links and window.open() to the system browser. Call once at startup. */
export function initDesktop() {
  if (!isDesktopApp) return;
  window.open = (url) => {
    if (url) openExternal(new URL(url, location.href).href);
    return null;
  };
  document.addEventListener(
    'click',
    (e) => {
      const link = e.target.closest?.('a[target="_blank"][href]');
      if (!link) return;
      e.preventDefault();
      openExternal(link.href);
    },
    true,
  );
}
