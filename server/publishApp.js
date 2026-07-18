// Publish the current web build as an OTA bundle the phones can pull.
//
//   npm run app:publish        (= vite build + this script)
//
// Zips dist/ into data/app/<version>.zip and points data/app/latest.json at it.
// The phone polls /app/latest, compares the version with the one it is running and
// downloads the zip when they differ (src/appUpdate.js) — so publishing here is the
// whole "ship a web change to the APK" story; no reinstall, no Play Store.
//
// The version is the package version plus a build timestamp
// (e.g. `0.1.0-202607181530`). It is compared for EQUALITY, never ordered: the
// server is the single source of truth for what the phones should run, which makes
// rolling back as simple as re-publishing an older build.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { zipSync } from 'fflate';
import { APP_DIR, LATEST_PATH, bundlePath } from './app-bundle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');

/** How many older bundles to keep on disk (for a quick rollback). */
const KEEP = 3;

/** Every file under `dir`, as paths relative to it (POSIX separators, as zips want). */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

function buildVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
  return `${pkg.version}-${stamp}`;
}

/** Drop all but the newest KEEP zips, so data/app/ doesn't grow forever. */
function prune(keepVersion) {
  const zips = readdirSync(APP_DIR)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => ({ f, at: statSync(join(APP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { f } of zips.slice(KEEP)) {
    if (f !== `${keepVersion}.zip`) unlinkSync(join(APP_DIR, f));
  }
}

try {
  statSync(join(DIST, 'index.html'));
} catch {
  console.error('No dist/index.html — run `npm run build` first (or use `npm run app:publish`).');
  process.exit(1);
}

mkdirSync(APP_DIR, { recursive: true });

// Files at the ROOT of the zip (index.html included): that is the layout the
// updater expects when it swaps the WebView's asset directory.
const files = {};
for (const rel of walk(DIST)) files[rel] = new Uint8Array(readFileSync(join(DIST, rel)));

const version = buildVersion();
const zip = zipSync(files, { level: 6 });
writeFileSync(bundlePath(version), zip);

const manifest = {
  version,
  size: zip.byteLength,
  sha256: createHash('sha256').update(zip).digest('hex'),
  publishedAt: Date.now(),
};
writeFileSync(LATEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
prune(version);

const kb = (zip.byteLength / 1024).toFixed(0);
console.log(`Published web bundle ${version} (${Object.keys(files).length} files, ${kb} KB).`);
console.log('Phones on the LAN will pick it up the next time they start the app.');
