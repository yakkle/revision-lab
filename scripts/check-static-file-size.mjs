import { readdir, stat } from "node:fs/promises";
import { resolve, relative } from "node:path";

const MEBIBYTE = 1024 * 1024;
const LIMIT_BYTES = 25 * MEBIBYTE;
const targetDirectory = resolve(process.argv[2] ?? "dist");

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
}

function formatMiB(bytes) {
  return `${(bytes / MEBIBYTE).toFixed(2)} MiB`;
}

let files;

try {
  files = await collectFiles(targetDirectory);
} catch (error) {
  console.error(`Static asset directory is not readable: ${targetDirectory}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  files = [];
}

if (process.exitCode !== 1) {
  const measured = await Promise.all(
    files.map(async (path) => ({
      path,
      size: (await stat(path)).size,
    })),
  );
  const oversized = measured.filter(({ size }) => size >= LIMIT_BYTES);

  if (oversized.length > 0) {
    console.error(`Static assets must each be smaller than ${formatMiB(LIMIT_BYTES)}:`);
    for (const file of oversized) {
      console.error(`- ${relative(targetDirectory, file.path)} (${formatMiB(file.size)})`);
    }
    process.exitCode = 1;
  } else {
    const largest = measured.toSorted((left, right) => right.size - left.size)[0];
    console.log(
      largest
        ? `Static asset size check passed: ${measured.length} files; largest is ${relative(targetDirectory, largest.path)} (${formatMiB(largest.size)}).`
        : "Static asset size check passed: no files found.",
    );
  }
}
