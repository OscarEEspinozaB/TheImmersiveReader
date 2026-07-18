// Edge-to-edge on Android (Capacitor). The WebView is told to draw *behind* the
// system status bar so the app reaches the very top of the screen; the CSS
// already reserves that space via `env(safe-area-inset-top)` (--sat), so nothing
// is covered. No-op on the web, where the browser owns the chrome.
//
// The only per-theme concern is icon contrast: an overlaid bar shares the app's
// background, so the clock/battery icons must be dark on a light theme and light
// on a dark theme. Capacitor's Style maps inversely to the *background*:
//   Style.Dark  → light icons (use on our dark themes)
//   Style.Light → dark icons  (use on our light themes)

const NATIVE = !!globalThis.Capacitor?.isNativePlatform?.();

let StatusBar = null;
let Style = null;

/** Load the plugin once (native only) and enable overlay/transparent mode. */
export async function initStatusBar() {
  if (!NATIVE) return;
  try {
    ({ StatusBar, Style } = await import('@capacitor/status-bar'));
    // Draw the WebView under the status bar (true edge-to-edge).
    await StatusBar.setOverlaysWebView({ overlay: true });
    // Transparent bar so the app background shows through.
    await StatusBar.setBackgroundColor({ color: '#00000000' });
  } catch {
    /* plugin unavailable → leave the default (non-overlaid) bar */
  }
}

/**
 * Match the status-bar icon color to the active theme mode.
 * @param {'dark'|'light'} mode
 */
export async function syncStatusBarStyle(mode) {
  if (!NATIVE || !StatusBar || !Style) return;
  try {
    await StatusBar.setStyle({ style: mode === 'light' ? Style.Light : Style.Dark });
  } catch {
    /* ignore — non-fatal cosmetic call */
  }
}
