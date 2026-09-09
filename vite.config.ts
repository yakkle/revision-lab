import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const isolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [react(), {
    name: "worker-module-cache-policy",
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        // Apply before sirv's early 304 path as well as normal asset responses.
        for (const [name, value] of Object.entries(isolationHeaders)) response.setHeader(name, value);
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
    headers: { ...isolationHeaders, "Cache-Control": "no-store" },
  },
  preview: {
    headers: isolationHeaders,
  },
});
