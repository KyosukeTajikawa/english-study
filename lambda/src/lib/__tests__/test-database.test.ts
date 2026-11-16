import { describe, expect, it } from "vitest";
import { resolveTestDatabaseUrl } from "../test-database.js";

const PRODUCTION_POOLED = "postgresql://u:p@ep-prod-1-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const PRODUCTION_DIRECT = "postgresql://u:p@ep-prod-1.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const TEST_POOLED = "postgresql://u:p@ep-test-2-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";

describe("resolveTestDatabaseUrl", () => {
  it("returns the test URL when it points to a different branch", () => {
    // Act
    const url = resolveTestDatabaseUrl({
      test: TEST_POOLED,
      production: [PRODUCTION_POOLED, PRODUCTION_DIRECT],
    });

    // Assert
    expect(url).toBe(TEST_POOLED);
  });

  it("rejects the production pooled URL used as the test URL", () => {
    expect(() =>
      resolveTestDatabaseUrl({ test: PRODUCTION_POOLED, production: [PRODUCTION_POOLED] }),
    ).toThrow("本番と同じ DB");
  });

  it("treats pooled and direct URLs of the same branch as the same database", () => {
    expect(() =>
      resolveTestDatabaseUrl({ test: PRODUCTION_DIRECT, production: [PRODUCTION_POOLED] }),
    ).toThrow("本番と同じ DB");
  });

  it("allows another database name on the same host", () => {
    const sameHostOtherDb = PRODUCTION_POOLED.replace("/neondb", "/neondb_test");

    const url = resolveTestDatabaseUrl({ test: sameHostOtherDb, production: [PRODUCTION_POOLED] });

    expect(url).toBe(sameHostOtherDb);
  });

  it("fails when the test URL is missing", () => {
    expect(() => resolveTestDatabaseUrl({ test: undefined, production: [PRODUCTION_POOLED] })).toThrow(
      "DATABASE_URL_TEST is not set",
    );
  });

  it("fails when there is no production URL to compare against", () => {
    expect(() => resolveTestDatabaseUrl({ test: TEST_POOLED, production: [undefined, ""] })).toThrow(
      "判定できません",
    );
  });

  it("fails on a malformed URL without echoing its credentials", () => {
    const run = () =>
      resolveTestDatabaseUrl({ test: "not a url with secret-password", production: [PRODUCTION_POOLED] });

    expect(run).toThrow("形式が正しくありません");
    expect(run).not.toThrow("secret-password");
  });
});
