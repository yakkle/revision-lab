import { randomBytes } from "node:crypto";
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

function developmentCsp(nonce: string): string {
  return appCsp
    .replace("script-src 'self' 'wasm-unsafe-eval'", `script-src 'self' 'wasm-unsafe-eval' 'nonce-${nonce}'`)
    .replace("style-src 'self' 'unsafe-inline'", `style-src 'self' 'nonce-${nonce}'`)
    .replace("connect-src 'self'", "connect-src 'self' ws: wss:");
}

function isPgliteWorker(pathname: string): boolean {
  return /\/assets\/pglite\.worker-[^/]+\.js$/.test(pathname) || /\/src\/runtime\/pglite\.worker\.ts$/.test(pathname);
}

function setRuntimeHeaders(
  request: { url?: string },
  response: { setHeader(name: string, value: string): void },
  documentCsp = appCsp,
): void {
  for (const [name, value] of Object.entries(isolationHeaders)) response.setHeader(name, value);
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  response.setHeader("Content-Security-Policy", isPgliteWorker(pathname) ? pgliteWorkerCsp : documentCsp);
}

export default defineConfig(({ command, isPreview }) => {
  const isDevelopment = command === "serve" && isPreview !== true;
  // This nonce exists only for the local Vite server lifetime. Production keeps
  // the static, nonce-free CSP from _headers and the preview middleware below.
  const devNonce = isDevelopment ? randomBytes(18).toString("base64") : undefined;
  const devCsp = devNonce ? developmentCsp(devNonce) : appCsp;

  return {
    base: process.env.VITE_BASE_PATH ?? "/",
    html: devNonce ? { cspNonce: devNonce } : undefined,
    plugins: [react(), {
      name: "worker-module-cache-policy",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          setRuntimeHeaders(request, response, devCsp);
          response.setHeader("Cache-Control", "no-store");
          next();
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use((request, response, next) => {
          // Apply before sirv's early 304 path as well as normal asset responses.
          setRuntimeHeaders(request, response);
          const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
          if (/\.m?js$/.test(pathname)) response.setHeader("Cache-Control", "no-store");
          next();
        });
      },
    }],
    worker: { format: "es" },
    server: { headers: isolationHeaders },
    preview: { headers: isolationHeaders },
  };
});
