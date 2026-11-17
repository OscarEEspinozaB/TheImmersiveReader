// A thin fetch proxy for "Import from a link" (src/webImport.js) on the WEB build:
// a browser may only read another site's page when that site allows it (CORS), and
// most do not. The phone does not need this (the APK fetches natively) and neither
// does Wikipedia (its API is CORS-open) — this is only the desktop browser's road
// to an ordinary article page.
//
//   GET /fetch?url=<http(s) URL>  -> the response body, with its Content-Type
//
// Deliberately dumb: no parsing, no extraction (the client does that — the server
// stays thin), a size cap and a timeout. Trusted LAN only, like the rest of the API.

import { Router } from 'express';
import { kbLog, KB_COLORS as C } from '../log.js';

export const fetchPageRouter = Router();

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 20000;

fetchPageRouter.get('/fetch', async (req, res) => {
  let target;
  try {
    target = new URL(String(req.query.url || ''));
  } catch {
    return res.status(400).json({ error: 'Invalid url' });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return res.status(400).json({ error: 'Only http(s) URLs' });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(target, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,image/avif,image/webp,image/*,*/*;q=0.8',
      },
    });
    if (Number(r.headers.get('content-length') || 0) > MAX_BYTES) {
      return res.status(413).json({ error: 'Too large' });
    }
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > MAX_BYTES) return res.status(413).json({ error: 'Too large' });
    kbLog(C.cyan, 'fetch', target.hostname, `${r.status} · ${Math.round(body.length / 1024)} KB`);
    res.status(r.status).type(r.headers.get('content-type') || 'application/octet-stream').send(body);
  } catch (err) {
    kbLog(C.red, 'fetch', target.hostname, err.name === 'AbortError' ? 'timed out' : err.message);
    res.status(502).json({ error: err.name === 'AbortError' ? 'Timed out' : err.message });
  } finally {
    clearTimeout(timer);
  }
});
