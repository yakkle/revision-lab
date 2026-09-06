import { describe, expect, it } from "vitest";
import { decodeValue, encodeValue } from "./value-codec";

describe("tagged PostgreSQL value codec", () => {
  it("preserves bigint, numeric and bytea without lossy coercion", () => {
    expect(encodeValue(9_007_199_254_740_993n, 20)).toEqual({ tag: "bigint", value: "9007199254740993" });
    expect(encodeValue(123.45, 1700)).toEqual({ tag: "decimal", value: "123.45" });
    const encodedBytes = encodeValue(new Uint8Array([0, 127, 255]));
    expect(encodedBytes).toEqual({ tag: "bytea", value: "AH//" });
    expect(decodeValue(encodedBytes)).toEqual(new Uint8Array([0, 127, 255]));
  });

  it("rejects unsafe untagged JavaScript integers", () => {
    expect(() => encodeValue(Number.MAX_SAFE_INTEGER + 1)).toThrow("UNSUPPORTED_VALUE_TYPE");
  });
});
