import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const isolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const appCsp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
// PGlite 0.5.8's PostgreSQL WASM dynamic-module loader uses direct eval inside
// its dedicated Worker. Keep that exception off the document and other assets.
const pgliteWorkerCsp = appCsp.replace("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'");

function setRuntimeHeaders(request: { url?: string }, response: { setHeader(name: string, value: string): void }): void {
  for (const [name, value] of Object.entries(isolationHeaders)) response.setHeader(name, value);
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  response.setHeader("Content-Security-Policy", /\/assets\/pglite\.worker-[^/]+\.js$/.test(pathname) ? pgliteWorkerCsp : appCsp);
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [react(), {
    name: "worker-module-cache-policy",
    configureServer(server) {
      server.middlewares.use((request, response, next) => { setRuntimeHeaders(request, response); response.setHeader("Cache-Control", "no-store"); next(); });
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        // Apply before sirv's early 304 path as well as normal asset responses.
        setRuntimeHeaders(request, response);
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        if (/\.m?js$/.test(pathname)) {
          response.setHeader("Cache-Control", "no-store");
        }
        next();
      });
    },
  }],
  worker: { format: "es" },
  server: {
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
});
