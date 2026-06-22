import { defineConfig } from 'vite';

// Phase 1 is a fully client-side app.
export default defineConfig({
  base: './',
  server: {
    // Listen on all network interfaces so the app is reachable from other
    // devices on the local network (e.g. a phone) at http://<machine-ip>:5173.
    host: true,
    port: 5173,
  },
});
