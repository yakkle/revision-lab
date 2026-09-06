import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const root = resolve("dist");
const port = Number.parseInt(process.env.PORT ?? "4174", 10);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
  const requestedPath = resolve(root, `.${decodeURIComponent(pathname)}`);
  const safePath = requestedPath === root || requestedPath.startsWith(`${root}${sep}`);
  let filePath = safePath ? requestedPath : resolve(root, "index.html");

  try {
    const fileStats = await stat(filePath);
    if (fileStats.isDirectory()) {
      filePath = resolve(filePath, "index.html");
    }
    await stat(filePath);
  } catch {
    filePath = resolve(root, "index.html");
  }

  response.statusCode = 200;
  response.setHeader("Content-Type", contentTypes[extname(filePath)] ?? "application/octet-stream");
  response.setHeader("X-Content-Type-Options", "nosniff");
  createReadStream(filePath).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Headerless fixture listening on http://127.0.0.1:${port}`);
});

const close = () => server.close(() => process.exit(0));
process.on("SIGINT", close);
process.on("SIGTERM", close);
