// Over-the-air (OTA) web-bundle updates for the Android app.
//
//   GET /app/latest      -> { version, size, sha256, publishedAt } (404 if none)
//   GET /app/bundle.zip  -> the published web bundle (a zip of dist/)
//
// The APK is a native shell around the SAME web app (docs/android.md). Instead of
// reinstalling the APK for every web change, the phone asks this endpoint for the
// latest published bundle and downloads it over the LAN; @capgo/capacitor-updater
// swaps the WebView's assets at the next start. The APK's embedded bundle stays as
// the offline fallback, so nothing here is ever required to launch the app.
//
// Publishing is a local action, not an HTTP one: `npm run app:publish` builds the
// web and writes the zip + latest.json into data/app/ (see server/publishApp.js).
// Read-only over the network — the LAN is trusted, but not trusted enough to let a
// device push code that every other device will run.

import { Router } from 'express';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { bundlePath, LATEST_PATH } from '../app-bundle.js';

export const appUpdateRouter = Router();

/** The published manifest, or null when nothing has been published yet. */
function readLatest() {
  if (!existsSync(LATEST_PATH)) return null;
  try {
    const latest = JSON.parse(readFileSync(LATEST_PATH, 'utf8'));
    // A manifest whose payload is gone would send the phone into a failed download.
    return latest?.version && existsSync(bundlePath(latest.version)) ? latest : null;
  } catch {
    return null;
  }
}

appUpdateRouter.get('/app/latest', (_req, res) => {
  const latest = readLatest();
  if (!latest) return res.status(404).json({ error: 'no bundle published' });
  res.json(latest);
});

appUpdateRouter.get('/app/bundle.zip', (_req, res) => {
  const latest = readLatest();
  if (!latest) return res.status(404).json({ error: 'no bundle published' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', String(latest.size));
  createReadStream(bundlePath(latest.version)).pipe(res);
});
