import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(new URL("../public/runtime/manifest.json", import.meta.url)));

const pythonWheels = [
  { file: "alembic-1.19.1-py3-none-any.whl", sha256: "b39018cb3d9413a19cbd54cf3c02ad33998641f0538eb77413a488a21c3e14be" },
  { file: "mako-1.3.10-py3-none-any.whl", sha256: "baef24a52fc4fc514a0887ac600f9f1cff3d82c61d4d700a1fa84d597b88db59" },
];

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

const pyodideRoot = dirname(require.resolve("pyodide"));
const pyodideLock = JSON.parse(await readFile(resolve(pyodideRoot, "pyodide-lock.json")));
for (const packageName of ["micropip", "sqlalchemy", "typing-extensions", "markupsafe"]) {
  const packageEntry = pyodideLock.packages[packageName];
  if (!packageEntry?.file_name) throw new Error(`Pyodide package is missing: ${packageName}`);
  const source = new URL(`../vendor/runtime-wheels/${packageEntry.file_name}`, import.meta.url);
  const digest = createHash("sha256").update(await readFile(source)).digest("hex");
  if (digest !== packageEntry.sha256) throw new Error(`${packageName}: vendored wheel checksum mismatch`);
  await copyFile(source, new URL(`../public/runtime/pyodide/${packageEntry.file_name}`, import.meta.url));
}

const wheelTarget = new URL("../public/runtime/wheels/", import.meta.url);
await mkdir(wheelTarget, { recursive: true });
await Promise.all(pythonWheels.map(async ({ file, sha256 }) => {
  const source = new URL(`../vendor/runtime-wheels/${file}`, import.meta.url);
  const digest = createHash("sha256").update(await readFile(source)).digest("hex");
  if (digest !== sha256) throw new Error(`${file}: vendored wheel checksum mismatch`);
  await copyFile(source, new URL(file, wheelTarget));
}));
