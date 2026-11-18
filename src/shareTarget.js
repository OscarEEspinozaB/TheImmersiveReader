// "Share → The Immersive Reader" (Android): text or a link shared from any other app
// arrives here from the app's own native plugin (android/…/ShareTargetPlugin.java)
// as a "shared" event { text, subject? }. The plugin RETAINS an event until this
// listener exists, so a share that cold-starts the app is delivered once the app has
// booted. What a share becomes (a link → an imported page, text → a new note) is
// main.js's decision. No-op on the web, and on an APK built before the plugin.

import { registerPlugin } from '@capacitor/core';

const NATIVE = !!globalThis.Capacitor?.isNativePlatform?.();
const ShareTarget = registerPlugin('ShareTarget');

/**
 * Start receiving shares. Call once the app has finished booting (its first view
 * is up), so a share is never overridden by the startup navigation.
 * @param {(share: { text: string, subject?: string }) => void} onShare
 */
export function initShareTarget(onShare) {
  if (!NATIVE) return;
  try {
    Promise.resolve(ShareTarget.addListener('shared', (share) => onShare(share || {}))).catch(() => {});
  } catch {
    // an older APK without the plugin: sharing to the app simply isn't offered
  }
}
