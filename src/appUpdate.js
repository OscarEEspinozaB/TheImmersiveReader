// Over-the-air (OTA) updates for the Android app.
//
// The APK is a native shell around the web build (docs/android.md). Shipping a web
// change used to mean rebuilding and reinstalling the APK; instead the shell asks
// the update server for the latest published bundle (`npm run app:publish`) and,
// when it differs from what it is running, downloads it over the LAN and stages it
// for the next start. @capgo/capacitor-updater does the unzip + asset-directory swap.
//
// Four rules keep this from ever being able to brick the app:
//   1. No-op on the web and whenever the server is unreachable — the APK's embedded
//      bundle keeps working offline exactly as before. This is an optimization,
//      never a dependency.
//   2. `notifyAppReady()` runs on every start. If a downloaded bundle fails to boot
//      it never reaches that call and the native side rolls back to the last good one.
//   3. The new bundle is *staged*, not swapped under the reader mid-sentence: it
//      applies at the next app start, or now if the user presses the visible button.
//   4. There is a manual way back. A WebView has no address bar, so a bundle that
//      loads but misbehaves would otherwise be a dead end: Settings → App updates →
//      "Go back to previous version" steps back ONE bundle, to the last one that
//      worked — never all the way to the APK's own, which would throw away every
//      good update in between.

// Statically imported on purpose. A dynamic import() would put the plugin in its
// own chunk, and a chunk that fails to load inside the WebView leaves every call
// awaiting forever — a hang with no error and no network request, which is exactly
// the failure mode this module must never have. Importing it on the web is harmless:
// it only registers a plugin proxy, and `isNativeApp` gates every call.
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { getUpdateUrl } from './settings.js';

/** True inside the APK; false in any browser. The whole module is Android-only. */
export const isNativeApp = !!globalThis.Capacitor?.isNativePlatform?.();

/** Don't leave the boot path hanging on an unreachable server. */
const TIMEOUT_MS = 8000;

/** The bundle is ~1 MB over the LAN, but a phone on a bad link deserves room. */
const DOWNLOAD_TIMEOUT_MS = 120000;

/** Set by initAppUpdate, so a manual check reports a staged update the same way. */
let onStagedHook = null;

/** The plugin on native; null in a browser, where none of this applies. */
function plugin() {
  return isNativeApp && CapacitorUpdater ? CapacitorUpdater : null;
}

/**
 * Reject rather than hang. Native bridge calls and fetches should always settle,
 * but "should" is what left the UI stuck on "Checking…", so every await in this
 * module goes through here.
 */
function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
  ]);
}

/**
 * Confirm this bundle boots, then look for a newer one in the background.
 * Safe to call unconditionally: a no-op on the web.
 * @param {{ onStaged?: (version: string) => void }} [hooks] told when an update has
 *   been downloaded and is waiting for a restart, so the UI can say so.
 */
export async function initAppUpdate({ onStaged } = {}) {
  onStagedHook = onStaged || null;
  const api = plugin();
  if (!api) return;
  // Rule 2: we booted, so whatever is running is good. Must happen even if the
  // check below throws, or the native side would roll this bundle back.
  try {
    await api.notifyAppReady();
  } catch {
    /* not fatal: the very first launch of a freshly installed APK */
  }
  checkForUpdate(api, onStaged).catch(() => {
    /* offline / no server / nothing published — stay on the current bundle */
  });
}

/**
 * The bundle now running: its version and whether it came from the APK itself.
 * @returns {Promise<{version: string, builtin: boolean}|null>}
 */
export async function currentBundle() {
  const api = plugin();
  if (!api) return null;
  const { bundle, native } = await withTimeout(api.current(), TIMEOUT_MS, 'current()');
  return { version: bundle?.version || 'builtin', builtin: bundle?.version === native };
}

/**
 * Check now, from a visible button (Settings → App updates). Unlike the boot check
 * this reports what happened — including the actual error text, because inside a
 * WebView there is no console to read and "it did nothing" is not a diagnosis.
 * @returns {Promise<{status: 'updated'|'current'|'failed'|'unsupported', detail?: string}>}
 */
export async function checkNow() {
  const api = plugin();
  if (!api) return { status: 'unsupported' };
  try {
    return { status: (await checkForUpdate(api, onStagedHook)) ? 'updated' : 'current' };
  } catch (err) {
    return { status: 'failed', detail: String(err?.message || err) };
  }
}

/**
 * The escape hatch (rule 4): step back to the last bundle that worked and reload.
 * One version back, not a factory reset — the plugin only falls through to the
 * APK's built-in bundle when there is no earlier good one to return to (which is
 * also what the automatic rollback does when a bundle fails to boot).
 */
export async function rollbackToPrevious() {
  const api = plugin();
  if (!api) return;
  await api.reset({ toLastSuccessful: true });
}

/** @returns {Promise<boolean>} true when a newer bundle was downloaded and staged. */
async function checkForUpdate(api, onStaged) {
  const base = getUpdateUrl();
  if (!base) return false; // no update server configured

  // A 404 here is a real, nameable state ("you never published"), not a failure to
  // hide behind "up to date".
  const latest = await fetchJson(`${base}/app/latest`);
  if (!latest?.version) throw new Error('server has no published bundle');

  const current = await withTimeout(api.current(), TIMEOUT_MS, 'current()');
  if (current?.bundle?.version === latest.version) return false;

  // A previous run may have already downloaded this exact version (e.g. the user
  // never restarted). Re-use it instead of pulling the zip again.
  const { bundles = [] } = await withTimeout(api.list(), TIMEOUT_MS, 'list()');
  const staged = bundles.find((b) => b.version === latest.version && b.status !== 'error');

  // No `checksum` option: the plugin's checksum is tied to its own (optionally
  // encrypted) packaging, and a mismatch would silently reject every update. The
  // integrity that matters here is the zip's own — a truncated download fails to
  // unzip, and a bundle that doesn't boot is rolled back by rule 2.
  const bundle =
    staged ||
    (await withTimeout(
      api.download({
        url: `${base}/app/bundle.zip?v=${encodeURIComponent(latest.version)}`,
        version: latest.version,
      }),
      DOWNLOAD_TIMEOUT_MS,
      'download()',
    ));

  // Rule 3: stage it for the next start, and offer the immediate switch as a
  // visible button (never a silent reload while someone is reading).
  await withTimeout(api.next({ id: bundle.id }), TIMEOUT_MS, 'next()');
  onStaged?.(latest.version);
  showUpdateBanner(() => api.set({ id: bundle.id }));
  return true;
}

async function fetchJson(url) {
  // Not AbortSignal.timeout(): it needs a recent WebView, and this must work on
  // every phone the APK installs on.
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: control.signal });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A dismissible bar: the update is already in place for the next start, so this
 * only offers to skip the wait.
 * @param {() => Promise<unknown>} apply
 */
function showUpdateBanner(apply) {
  if (document.querySelector('.app-update')) return;
  const bar = document.createElement('div');
  bar.className = 'app-update';
  bar.innerHTML = `
    <span class="app-update__text">A new version is ready.</span>
    <button class="app-update__apply" type="button">Restart now</button>
    <button class="app-update__later" type="button">Later</button>`;
  bar.querySelector('.app-update__apply').addEventListener('click', () => apply());
  bar.querySelector('.app-update__later').addEventListener('click', () => bar.remove());
  document.body.appendChild(bar);
}
