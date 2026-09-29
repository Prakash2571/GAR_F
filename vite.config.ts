import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
//
// SAME-ORIGIN MODEL, IN DEV TOO
// -----------------------------
// Production serves the SPA and the API on ONE origin behind nginx, so the frontend makes
// RELATIVE "/api/..." requests (see src/api/http.ts — an absent VITE_API_BASE_URL resolves to
// same-origin). To preserve that exact model in development instead of requiring an explicit
// base URL, the Vite dev server proxies "/api" to the local backend on 127.0.0.1:3001. So in
// dev the browser still talks only to the Vite origin (http://localhost:5173) and never sees a
// cross-origin request — the same-origin cookie + CSRF story is identical to production.
//
// WHY 127.0.0.1 AND NOT localhost
// -------------------------------
// The proxy TARGET is 127.0.0.1 (not "localhost") so it never depends on how the OS resolves
// "localhost" (IPv4 vs IPv6 ::1) — a mismatch there is the classic "works on my machine" dev
// footgun. The whole app is documented to use 127.0.0.1:3001 for the backend consistently.
//
// WHY changeOrigin IS false
// -------------------------
// The backend enforces an EXACT-origin CORS allow-list and a CSRF Origin check. With
// `changeOrigin: false` (the default, set explicitly here for clarity) the proxied request
// keeps the browser's original `Origin`/`Host` (the Vite dev origin) rather than having them
// rewritten to the target — so the backend sees a stable, expected Origin and the session
// cookie + CSRF Origin check behave the same way they do in production behind nginx. Rewriting
// the Origin to 127.0.0.1:3001 could trip the exact-origin check or land the Set-Cookie on the
// wrong host.
//
// WHY THE SSE STREAMS
// -------------------
// `/api/box/stream` is a Server-Sent Events endpoint. http-proxy streams responses by default;
// the important part is that NO response buffering is introduced and the connection is kept
// alive, so events arrive incrementally rather than all at once when the stream closes. We do
// not set a `timeout` (which would cut a long-lived idle stream) and we do not transform the
// body, so the SSE flows through untouched. `ws: false` because SSE is plain HTTP, not
// WebSocket.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The synthetic service (gts-synth, Go) on its own port, listed BEFORE "/api" so it
      // wins — exactly what nginx's `location ^~ /api/synth/` does in production. Same
      // origin, same cookie, same CSRF header.
      "/api/synth": {
        target: "http://127.0.0.1:3101",
        changeOrigin: false,
        ws: false,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("Accept-Encoding", "identity");
          });
        },
      },
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: false,
        ws: false,
        // Do not buffer or time out the long-lived SSE stream; let events flow incrementally.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            // Ask the backend not to compress the SSE so intermediaries never buffer it.
            proxyReq.setHeader("Accept-Encoding", "identity");
          });
        },
      },
    },
  },
});
