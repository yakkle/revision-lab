import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(new URL("../public/runtime/manifest.json", import.meta.url)));

const assets = [
  {
    packageName: "pyodide",
    manifestKey: "pyodide",
    files: ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"],
  },
  {
    packageName: "@electric-sql/pglite",
    manifestKey: "pglite",
    files: ["pglite.wasm", "initdb.wasm", "pglite.data"],
  },
];

for (const asset of assets) {
  const entry = require.resolve(asset.packageName);
  const packageRoot = asset.packageName === "pyodide" ? dirname(entry) : resolve(dirname(entry), "..");
  const packageJson = resolve(packageRoot, "package.json");
  const pkg = JSON.parse(await readFile(packageJson));
  const expected = manifest.assets[asset.manifestKey].version;
  if (pkg.version !== expected) throw new Error(`${asset.packageName}: expected ${expected}, found ${pkg.version}`);

  const sourceRoot = asset.packageName === "pyodide" ? packageRoot : resolve(packageRoot, "dist");
  const targetRoot = new URL(`../public/${manifest.assets[asset.manifestKey].basePath}`, import.meta.url);
  await mkdir(targetRoot, { recursive: true });
  await Promise.all(asset.files.map((file) => copyFile(resolve(sourceRoot, file), new URL(file, targetRoot))));
}
