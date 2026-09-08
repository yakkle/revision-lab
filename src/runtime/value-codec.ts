import type { TaggedValue } from "./protocol";

const OID = { bytea: 17, int8: 20, int2Vector: 22, date: 1082, time: 1083, timestamp: 1114, timestampTz: 1184, timeTz: 1266, numeric: 1700 };

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeValue(value: unknown, dataTypeId?: number): TaggedValue {
  if (value === null || value === undefined) return { tag: "null" };
  if (Array.isArray(value)) return { tag: "array", value: value.map((item) => encodeValue(item)) };
  if (value instanceof Uint8Array) return { tag: "bytea", value: toBase64(value) };
  if (dataTypeId === OID.int2Vector && typeof value === "string") {
    return { tag: "array", value: value.trim() === "" ? [] : value.trim().split(/\s+/).map((item) => ({ tag: "number", value: Number(item) })) };
  }
  if (dataTypeId === OID.int8) return { tag: "bigint", value: String(value) };
  if (dataTypeId === OID.numeric) return { tag: "decimal", value: String(value) };
  if (dataTypeId === OID.date) return { tag: "date", value: value instanceof Date ? value.toISOString().slice(0, 10) : String(value), dataTypeId };
  if (dataTypeId === OID.time || dataTypeId === OID.timeTz) return { tag: "time", value: String(value), dataTypeId };
  if (dataTypeId === OID.timestamp || dataTypeId === OID.timestampTz) return { tag: "timestamp", value: value instanceof Date ? value.toISOString() : String(value), dataTypeId };
  if (value instanceof Date) return { tag: "timestamp", value: value.toISOString(), dataTypeId: OID.timestampTz };
  if (typeof value === "boolean") return { tag: "boolean", value };
  if (typeof value === "bigint") return { tag: "bigint", value: value.toString() };
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { tag: "special-number", value: "NaN" };
    if (value === Infinity) return { tag: "special-number", value: "Infinity" };
    if (value === -Infinity) return { tag: "special-number", value: "-Infinity" };
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error("UNSUPPORTED_VALUE_TYPE");
    return { tag: "number", value };
  }
  if (typeof value === "string") {
    if (dataTypeId === OID.bytea) return { tag: "bytea", value };
    return { tag: "string", value };
  }
  throw new Error("UNSUPPORTED_VALUE_TYPE");
}

export function decodeValue(value: TaggedValue): unknown {
  switch (value.tag) {
    case "null": return null;
    case "boolean": case "number": case "string": return value.value;
    case "bigint": return BigInt(value.value);
    case "decimal": case "date": case "time": case "timestamp": return value.value;
    case "bytea": return fromBase64(value.value);
    case "array": return value.value.map(decodeValue);
    case "special-number": return value.value === "NaN" ? NaN : value.value === "Infinity" ? Infinity : -Infinity;
  }
}
