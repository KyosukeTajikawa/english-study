import type { LambdaFunctionURLEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * index.ts のテスト。本番のコールドスタート時の環境検証（assertEnvironment）を確かめる。
 *
 * ★ ここが「テスト用の JWKS を指したまま本番に出る」事故の唯一の防波堤。
 *   検証は import した瞬間に走るので、テストごとにモジュールを読み込み直す。
 */

const route = vi.hoisted(() => vi.fn());
vi.mock("../router.js", () => ({ route }));

const TEAM_DOMAIN = "my-team.cloudflareaccess.com";

async function loadIndex(): Promise<typeof import("../index.js")> {
  vi.resetModules();
  return import("../index.js");
}

beforeEach(() => {
  route.mockReset();
  vi.stubEnv("INTERNAL_API_KEY_PARAMETER", "/english-study-app/internal-api-key");
  vi.stubEnv("DATABASE_URL_PARAMETER", "/english-study-app/database-url");
  vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", TEAM_DOMAIN);
  vi.stubEnv("CF_ACCESS_AUD", "production-audience");
  vi.stubEnv("CF_ACCESS_JWKS_URL", undefined);
});

describe("assertEnvironment (cold start)", () => {
  it("starts with a valid production environment and delegates to the router", async () => {
    // Arrange
    const { handler } = await loadIndex();
    const event = { rawPath: "/api/health" } as LambdaFunctionURLEvent;
    route.mockResolvedValue({ statusCode: 200 });

    // Act
    const result = await handler(event);

    // Assert
    expect(result).toEqual({ statusCode: 200 });
    expect(route).toHaveBeenCalledWith(event);
  });

  it("accepts a JWKS URL on the team domain", async () => {
    vi.stubEnv("CF_ACCESS_JWKS_URL", `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);

    await expect(loadIndex()).resolves.toBeDefined();
  });

  it("refuses to start when a required variable is missing", async () => {
    vi.stubEnv("CF_ACCESS_AUD", "");

    await expect(loadIndex()).rejects.toThrow("Missing required environment variables: CF_ACCESS_AUD");
  });

  it("refuses to start when the team domain is not Cloudflare Access", async () => {
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", "local-access.invalid");

    await expect(loadIndex()).rejects.toThrow("CF_ACCESS_TEAM_DOMAIN must point to Cloudflare Access");
  });

  it("refuses to start when the team domain contains more than a host name", async () => {
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", `${TEAM_DOMAIN}/path`);

    await expect(loadIndex()).rejects.toThrow("CF_ACCESS_TEAM_DOMAIN must be a bare host name");
  });

  it("refuses to start when the team domain is not a valid host name", async () => {
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", "bad host.cloudflareaccess.com");

    await expect(loadIndex()).rejects.toThrow("CF_ACCESS_TEAM_DOMAIN is not a valid URL");
  });

  it("refuses to start when the JWKS URL points to the local test keys", async () => {
    // ローカルの local-server が配信するテスト鍵。本番で信頼すると認証バイパスになる。
    vi.stubEnv("CF_ACCESS_JWKS_URL", "http://127.0.0.1:3001/__local/jwks.json");

    await expect(loadIndex()).rejects.toThrow("CF_ACCESS_JWKS_URL must point to Cloudflare Access");
  });

  it("refuses to start when the JWKS URL is on another Cloudflare Access team", async () => {
    // *.cloudflareaccess.com には誰でもチームを作れる。
    vi.stubEnv("CF_ACCESS_JWKS_URL", "https://attacker.cloudflareaccess.com/cdn-cgi/access/certs");

    await expect(loadIndex()).rejects.toThrow("CF_ACCESS_JWKS_URL must be on CF_ACCESS_TEAM_DOMAIN");
  });

  it("refuses to start when the JWKS URL is not https", async () => {
    vi.stubEnv("CF_ACCESS_JWKS_URL", `http://${TEAM_DOMAIN}/cdn-cgi/access/certs`);

    await expect(loadIndex()).rejects.toThrow("CF_ACCESS_JWKS_URL must point to Cloudflare Access");
  });
});
