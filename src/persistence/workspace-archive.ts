import type { DatabaseMode } from "../runtime/protocol";

export const ARCHIVE_FORMAT_VERSION = 1 as const;
export const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;
export const MAX_ARCHIVE_FILE_BYTES = 1024 * 1024;
export const MAX_ARCHIVE_DATABASE_BYTES = 32 * 1024 * 1024;
export const MAX_ARCHIVE_FILES = 200;
const MAX_ARCHIVE_ENTRIES = MAX_ARCHIVE_FILES + 2;
const MAX_UNCOMPRESSED_BYTES = 48 * 1024 * 1024;

export type WorkspaceArchiveV1 = {
  formatVersion: 1;
  workspace: { id: string; name: string; mode: DatabaseMode };
  files: Array<{ path: string; encoding: "utf8" | "base64"; content: string }>;
  database: { format: "sqlite-file" | "pglite-datadir"; content: ArrayBuffer };
  lessonProgress: Record<string, string>;
};

type ArchiveManifest = {
  formatVersion: 1;
  workspace: WorkspaceArchiveV1["workspace"];
  files: Array<{ path: string; encoding: "utf8" | "base64"; entry: string }>;
  database: { format: WorkspaceArchiveV1["database"]["format"]; entry: string };
  lessonProgress: Record<string, string>;
};

export class WorkspaceArchiveError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkspaceArchiveError";
  }
}

function fail(code: string, message: string): never { throw new WorkspaceArchiveError(code, message); }
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function isSafeWorkspacePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 512 && !path.startsWith("/") && !path.includes("\\") &&
    !path.includes("\0") && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function validWorkspace(value: unknown): value is WorkspaceArchiveV1["workspace"] {
  return isObject(value) && typeof value.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value.id) &&
    typeof value.name === "string" && value.name.length > 0 && value.name.length <= 120 &&
    (value.mode === "sqlite" || value.mode === "postgresql");
}

function validProgress(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.entries(value).length <= 64 &&
    Object.entries(value).every(([key, item]) => key.length > 0 && key.length <= 80 && typeof item === "string" && item.length <= 8192);
}

async function zipAsync(entries: Record<string, Uint8Array>): Promise<Uint8Array> {
  const { zip } = await import("fflate");
  return new Promise((resolve, reject) => zip(entries, { level: 6 }, (error, data) => error ? reject(error) : resolve(data)));
}

async function unzipAsync(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  const { unzip } = await import("fflate");
  return new Promise((resolve, reject) => unzip(data, (error, entries) => error ? reject(error) : resolve(entries)));
}

function readU16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) fail("ARCHIVE_CORRUPT", "ZIP 구조가 올바르지 않습니다.");
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) fail("ARCHIVE_CORRUPT", "ZIP 구조가 올바르지 않습니다.");
  return view.getUint32(offset, true);
}

// Read the central directory before decompression so forged size fields and ZIP bombs
// are rejected before fflate allocates their advertised output buffers.
export function preflightZip(data: Uint8Array): void {
  if (data.byteLength === 0 || data.byteLength > MAX_ARCHIVE_BYTES) fail("ARCHIVE_TOO_LARGE", "Archive는 40 MiB 이하여야 합니다.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const minimum = Math.max(0, data.byteLength - 65_557);
  let eocd = -1;
  for (let offset = data.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readU32(view, offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) fail("ARCHIVE_CORRUPT", "ZIP central directory를 찾을 수 없습니다.");
  const disk = readU16(view, eocd + 4);
  const centralDisk = readU16(view, eocd + 6);
  const entriesOnDisk = readU16(view, eocd + 8);
  const entries = readU16(view, eocd + 10);
  const centralSize = readU32(view, eocd + 12);
  const centralOffset = readU32(view, eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entries !== entriesOnDisk || entries > MAX_ARCHIVE_ENTRIES ||
    entries === 0 || centralOffset + centralSize > eocd) fail("ARCHIVE_UNSUPPORTED_ZIP", "분할·ZIP64 또는 항목 제한을 초과한 ZIP은 지원하지 않습니다.");
  let offset = centralOffset;
  let total = 0;
  const names = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < entries; index += 1) {
    if (readU32(view, offset) !== 0x02014b50) fail("ARCHIVE_CORRUPT", "ZIP central directory 항목이 손상되었습니다.");
    const flags = readU16(view, offset + 8);
    const compressed = readU32(view, offset + 20);
    const uncompressed = readU32(view, offset + 24);
    const nameLength = readU16(view, offset + 28);
    const extraLength = readU16(view, offset + 30);
    const commentLength = readU16(view, offset + 32);
    if ((flags & 1) !== 0 || compressed === 0xffffffff || uncompressed === 0xffffffff) fail("ARCHIVE_UNSUPPORTED_ZIP", "암호화 또는 ZIP64 archive는 지원하지 않습니다.");
    total += uncompressed;
    if (uncompressed > MAX_ARCHIVE_DATABASE_BYTES || total > MAX_UNCOMPRESSED_BYTES) fail("ARCHIVE_TOO_LARGE", "압축 해제 크기가 안전 제한을 초과합니다.");
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > data.byteLength) fail("ARCHIVE_CORRUPT", "ZIP 항목 이름이 손상되었습니다.");
    let name = "";
    try { name = decoder.decode(data.subarray(nameStart, nameEnd)); }
    catch { fail("ARCHIVE_INVALID_PATH", "ZIP 항목 이름은 올바른 UTF-8이어야 합니다."); }
    if (!isSafeWorkspacePath(name) || names.has(name)) fail("ARCHIVE_INVALID_PATH", "중복되거나 위험한 ZIP 경로가 있습니다.");
    names.add(name);
    offset = nameEnd + extraLength + commentLength;
  }
  if (offset !== centralOffset + centralSize) fail("ARCHIVE_CORRUPT", "ZIP central directory 크기가 일치하지 않습니다.");
}

function validateArchive(archive: WorkspaceArchiveV1): void {
  if (archive.formatVersion !== ARCHIVE_FORMAT_VERSION) fail("ARCHIVE_VERSION_UNSUPPORTED", "지원하지 않는 archive format version입니다.");
  if (!validWorkspace(archive.workspace) || !validProgress(archive.lessonProgress)) fail("ARCHIVE_INVALID_MANIFEST", "Workspace metadata가 올바르지 않습니다.");
  if (!Array.isArray(archive.files) || archive.files.length > MAX_ARCHIVE_FILES) fail("ARCHIVE_TOO_MANY_FILES", "Workspace 파일은 최대 200개까지 허용됩니다.");
  const paths = new Set<string>();
  const encoder = new TextEncoder();
  for (const file of archive.files) {
    if (!isSafeWorkspacePath(file.path) || paths.has(file.path) || (file.encoding !== "utf8" && file.encoding !== "base64") || typeof file.content !== "string") {
      fail("ARCHIVE_INVALID_FILE", "중복되거나 위험한 workspace 파일이 있습니다.");
    }
    paths.add(file.path);
    if (file.encoding !== "utf8") fail("ARCHIVE_UNSUPPORTED_ENCODING", "MVP workspace 파일은 UTF-8 텍스트만 지원합니다.");
    if (encoder.encode(file.content).byteLength > MAX_ARCHIVE_FILE_BYTES) fail("ARCHIVE_FILE_TOO_LARGE", `${file.path} 파일이 1 MiB를 초과합니다.`);
  }
  const expected = archive.workspace.mode === "sqlite" ? "sqlite-file" : "pglite-datadir";
  if (archive.database.format !== expected || !(archive.database.content instanceof ArrayBuffer) || archive.database.content.byteLength > MAX_ARCHIVE_DATABASE_BYTES) {
    fail("ARCHIVE_INVALID_DATABASE", "DB 모드와 database payload가 일치하지 않거나 32 MiB 제한을 초과합니다.");
  }
}

export async function createWorkspaceArchive(archive: WorkspaceArchiveV1): Promise<Blob> {
  validateArchive(archive);
  const { strToU8 } = await import("fflate");
  const files = archive.files.map((file, index) => ({ ...file, entry: `files/${String(index).padStart(3, "0")}.txt` }));
  const databaseEntry = archive.database.format === "sqlite-file" ? "database.sqlite" : "database.pglite.tgz";
  const manifest: ArchiveManifest = {
    formatVersion: 1,
    workspace: archive.workspace,
    files: files.map(({ path, encoding, entry }) => ({ path, encoding, entry })),
    database: { format: archive.database.format, entry: databaseEntry },
    lessonProgress: archive.lessonProgress,
  };
  const entries: Record<string, Uint8Array> = { "manifest.json": strToU8(JSON.stringify(manifest)), [databaseEntry]: new Uint8Array(archive.database.content) };
  files.forEach((file) => { entries[file.entry] = strToU8(file.content); });
  const result = await zipAsync(entries);
  if (result.byteLength > MAX_ARCHIVE_BYTES) fail("ARCHIVE_TOO_LARGE", "생성된 archive가 40 MiB 제한을 초과합니다.");
  return new Blob([result.slice().buffer], { type: "application/zip" });
}

function parseManifest(value: unknown): ArchiveManifest {
  if (!isObject(value) || value.formatVersion !== 1 || !validWorkspace(value.workspace) || !Array.isArray(value.files) ||
    value.files.length > MAX_ARCHIVE_FILES || !isObject(value.database) || !validProgress(value.lessonProgress)) {
    fail("ARCHIVE_INVALID_MANIFEST", "manifest.json 구조가 올바르지 않습니다.");
  }
  const manifest = value as Record<string, unknown>;
  const files = manifest.files as unknown[];
  if (!files.every((file) => isObject(file) && isSafeWorkspacePath(file.path) && file.encoding === "utf8" && isSafeWorkspacePath(file.entry))) {
    fail("ARCHIVE_INVALID_MANIFEST", "manifest의 파일 항목이 올바르지 않습니다.");
  }
  const paths = new Set(files.map((file) => (file as Record<string, unknown>).path));
  const fileEntries = new Set(files.map((file) => (file as Record<string, unknown>).entry));
  if (paths.size !== files.length || fileEntries.size !== files.length || fileEntries.has("manifest.json")) {
    fail("ARCHIVE_INVALID_MANIFEST", "manifest에 중복 파일 경로나 ZIP 항목이 있습니다.");
  }
  const database = manifest.database as Record<string, unknown>;
  if ((database.format !== "sqlite-file" && database.format !== "pglite-datadir") || !isSafeWorkspacePath(database.entry)) {
    fail("ARCHIVE_INVALID_MANIFEST", "manifest의 database 항목이 올바르지 않습니다.");
  }
  if (database.entry === "manifest.json" || fileEntries.has(database.entry)) {
    fail("ARCHIVE_INVALID_MANIFEST", "manifest의 database ZIP 항목이 다른 항목과 중복됩니다.");
  }
  return manifest as unknown as ArchiveManifest;
}

export async function readWorkspaceArchive(source: Blob | ArrayBuffer): Promise<WorkspaceArchiveV1> {
  const buffer = source instanceof Blob ? await source.arrayBuffer() : source;
  const bytes = new Uint8Array(buffer);
  preflightZip(bytes);
  let entries: Record<string, Uint8Array> = {};
  try { entries = await unzipAsync(bytes); }
  catch { fail("ARCHIVE_CORRUPT", "ZIP 압축을 해제할 수 없습니다."); }
  const manifestBytes = entries["manifest.json"];
  if (!manifestBytes || manifestBytes.byteLength > MAX_ARCHIVE_FILE_BYTES) fail("ARCHIVE_INVALID_MANIFEST", "manifest.json이 없거나 너무 큽니다.");
  let raw: unknown;
  try {
    const { strFromU8 } = await import("fflate");
    raw = JSON.parse(strFromU8(manifestBytes));
  }
  catch { fail("ARCHIVE_INVALID_MANIFEST", "manifest.json을 읽을 수 없습니다."); }
  const manifest = parseManifest(raw);
  const allowed = new Set(["manifest.json", manifest.database.entry, ...manifest.files.map((file) => file.entry)]);
  if (Object.keys(entries).some((name) => !allowed.has(name)) || allowed.size !== Object.keys(entries).length) {
    fail("ARCHIVE_UNEXPECTED_ENTRY", "manifest에 선언되지 않은 ZIP 항목이 있습니다.");
  }
  const seenPaths = new Set<string>();
  const files = manifest.files.map((file) => {
    if (seenPaths.has(file.path)) fail("ARCHIVE_INVALID_FILE", "중복 workspace 경로가 있습니다.");
    seenPaths.add(file.path);
    const content = entries[file.entry];
    if (!content || content.byteLength > MAX_ARCHIVE_FILE_BYTES) fail("ARCHIVE_FILE_TOO_LARGE", `${file.path} 파일이 없거나 너무 큽니다.`);
    let decoded = "";
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(content); }
    catch { fail("ARCHIVE_INVALID_FILE", `${file.path} 파일은 올바른 UTF-8이 아닙니다.`); }
    return { path: file.path, encoding: file.encoding, content: decoded };
  });
  const database = entries[manifest.database.entry];
  if (!database) fail("ARCHIVE_INVALID_DATABASE", "Database payload가 없습니다.");
  const archive: WorkspaceArchiveV1 = {
    formatVersion: 1,
    workspace: manifest.workspace,
    files,
    database: { format: manifest.database.format, content: database.slice().buffer },
    lessonProgress: manifest.lessonProgress,
  };
  validateArchive(archive);
  return archive;
}

export function archiveHasExecutablePython(archive: WorkspaceArchiveV1): boolean {
  return archive.files.some((file) => file.path.endsWith(".py"));
}
