import { defineConfig } from 'vite';

// Phase 1 is a fully client-side app.
export default defineConfig({
  base: './',
  server: {
    // Listen on all network interfaces so the app is reachable from other
    // devices on the local network (e.g. a phone) at http://<machine-ip>:5173.
    host: true,
    port: 5173,
    // FAIL if 5173 is taken instead of silently moving to 5174. Vite's default is
    // to slide to the next free port, which means a dev server you forgot to kill
    // leaves the new one somewhere else while your open tab keeps talking to the
    // OLD build — it looks like the app is broken (a stale HMR client retries its
    // websocket forever) when it is only the wrong port. Better to refuse to start
    // and say so.
    strictPort: true,
  },
});
