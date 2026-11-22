import { describe, expect, it } from "vitest";
import { hasInternalKeyHeader, isValidInternalKey } from "../internal-auth.js";

const EXPECTED = "expected-internal-key";

describe("isValidInternalKey", () => {
  it("accepts the expected key", () => {
    expect(isValidInternalKey({ "x-internal-api-key": EXPECTED }, EXPECTED)).toBe(true);
  });

  it("accepts the header name in any letter case", () => {
    expect(isValidInternalKey({ "X-Internal-Api-Key": EXPECTED }, EXPECTED)).toBe(true);
  });

  it("rejects a different key of the same length", () => {
    const sameLength = "x".repeat(EXPECTED.length);

    expect(isValidInternalKey({ "x-internal-api-key": sameLength }, EXPECTED)).toBe(false);
  });

  it("rejects a key of a different length without throwing", () => {
    expect(isValidInternalKey({ "x-internal-api-key": "short" }, EXPECTED)).toBe(false);
  });

  it("rejects a request without the header", () => {
    expect(isValidInternalKey({}, EXPECTED)).toBe(false);
  });

  it("never lets a request through when the expected key is not configured", () => {
    // 「期待値が空なら素通し」にすると、設定漏れがそのまま認証の穴になる。
    expect(isValidInternalKey({ "x-internal-api-key": "" }, "")).toBe(false);
    expect(isValidInternalKey({ "x-internal-api-key": "anything" }, undefined)).toBe(false);
  });
});

describe("hasInternalKeyHeader", () => {
  it("reports whether the header is present, regardless of its value", () => {
    expect(hasInternalKeyHeader({ "X-INTERNAL-API-KEY": "wrong" })).toBe(true);
    expect(hasInternalKeyHeader({ "content-type": "application/json" })).toBe(false);
  });
});
