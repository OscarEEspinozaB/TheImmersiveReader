// Where published web bundles live on disk. Shared by the publisher CLI
// (publishApp.js) and the route that serves them (routes/appUpdate.js), so the
// two can never disagree about the layout:
//
//   data/app/latest.json    the published manifest { version, size, sha256, publishedAt }
//   data/app/<version>.zip  the bundle itself (a zip of dist/, index.html at the root)

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const APP_DIR = process.env.APP_BUNDLE_DIR || join(__dirname, '..', 'data', 'app');
export const LATEST_PATH = join(APP_DIR, 'latest.json');
export const bundlePath = (version) => join(APP_DIR, `${version}.zip`);
