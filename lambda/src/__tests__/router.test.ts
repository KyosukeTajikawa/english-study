import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * router.ts のテスト。全ルート共通の認証（共有シークレット → JWT）の順序と、
 * 振り分けの結果（404 / 405 / 500）を確かめる。
 *
 * SSM と JWT 検証はそれぞれ専用のテストがあるので、ここではモックに差し替える。
 */

const mocks = vi.hoisted(() => ({
  getSecret: vi.fn<(name: string) => Promise<string>>(),
  verifyAccessJwt: vi.fn(),
  handleMe: vi.fn(),
}));

vi.mock("../lib/secrets.js", () => ({ getSecret: mocks.getSecret }));

vi.mock("../lib/auth.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/auth.js")>();
  // AuthenticationError は本物を使う（router が instanceof で判定するため）。
  return { ...original, verifyAccessJwt: mocks.verifyAccessJwt };
});

// /api/me は DB に触れるので差し替える。ハンドラが例外を投げた場合の確認にも使う。
vi.mock("../handlers/me.js", () => ({ handleMe: mocks.handleMe }));

const { route } = await import("../router.js");
const { AuthenticationError } = await import("../lib/auth.js");

const INTERNAL_KEY = "expected-internal-key";
const IDENTITY = { email: "learner@example.com" };

interface EventOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
}

function createEvent(options: EventOptions = {}): LambdaFunctionURLEvent {
  const path = options.path ?? "/api/health";
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: options.headers ?? {
      "x-internal-api-key": INTERNAL_KEY,
      "cf-access-jwt-assertion": "token",
    },
    requestContext: {
      accountId: "anonymous",
      apiId: "test",
      domainName: "example.lambda-url.ap-northeast-1.on.aws",
      domainPrefix: "example",
      requestId: "request-1",
      routeKey: "$default",
      stage: "$default",
      time: "",
      timeEpoch: 0,
      http: {
        method: options.method ?? "GET",
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
    },
    isBase64Encoded: false,
  };
}

type StructuredResult = Exclude<LambdaFunctionURLResult, string>;

function parse(result: LambdaFunctionURLResult): { statusCode?: number; body: unknown } {
  const structured = result as StructuredResult;
  return { statusCode: structured.statusCode, body: JSON.parse(structured.body ?? "null") };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSecret.mockResolvedValue(INTERNAL_KEY);
  mocks.verifyAccessJwt.mockResolvedValue(IDENTITY);
  // console.warn / console.error の出力でテスト結果を埋めない。
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("route: shared secret", () => {
  it("rejects a request without the internal key header before reading SSM", async () => {
    // Act
    const result = parse(await route(createEvent({ headers: { "cf-access-jwt-assertion": "token" } })));

    // Assert
    expect(result.statusCode).toBe(403);
    expect(mocks.getSecret).not.toHaveBeenCalled();
    expect(mocks.verifyAccessJwt).not.toHaveBeenCalled();
  });

  it("rejects a wrong internal key without verifying the JWT", async () => {
    const event = createEvent({
      headers: { "x-internal-api-key": "wrong", "cf-access-jwt-assertion": "token" },
    });

    const result = parse(await route(event));

    expect(result.statusCode).toBe(403);
    expect(mocks.verifyAccessJwt).not.toHaveBeenCalled();
  });

  it("fails closed with 500 when the expected key cannot be loaded", async () => {
    mocks.getSecret.mockRejectedValue(new Error("ssm down"));

    const result = parse(await route(createEvent()));

    expect(result.statusCode).toBe(500);
    expect(mocks.verifyAccessJwt).not.toHaveBeenCalled();
  });

  it("accepts header names in any letter case", async () => {
    const event = createEvent({
      headers: { "X-Internal-Api-Key": INTERNAL_KEY, "Cf-Access-Jwt-Assertion": "token" },
    });

    const result = parse(await route(event));

    expect(result.statusCode).toBe(200);
  });
});

describe("route: access token", () => {
  it("returns 401 when the JWT is invalid", async () => {
    mocks.verifyAccessJwt.mockRejectedValue(new AuthenticationError("invalid access token"));

    const result = parse(await route(createEvent()));

    expect(result.statusCode).toBe(401);
  });

  it("returns 500 when the JWT cannot be verified because of a server-side failure", async () => {
    mocks.verifyAccessJwt.mockRejectedValue(new Error("jwks unavailable"));

    const result = parse(await route(createEvent()));

    expect(result.statusCode).toBe(500);
  });

  it("authenticates before matching routes so unknown paths are not revealed", async () => {
    mocks.verifyAccessJwt.mockRejectedValue(new AuthenticationError("missing access token"));

    const result = parse(await route(createEvent({ path: "/api/does-not-exist" })));

    expect(result.statusCode).toBe(401);
  });
});

describe("route: dispatch", () => {
  it("dispatches GET /api/health", async () => {
    const result = parse(await route(createEvent()));

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ ok: true, data: { status: "ok" } });
  });

  it("ignores a trailing slash", async () => {
    const result = parse(await route(createEvent({ path: "/api/health/" })));

    expect(result.statusCode).toBe(200);
  });

  it("returns 404 for an unknown path", async () => {
    const result = parse(await route(createEvent({ path: "/api/unknown" })));

    expect(result.statusCode).toBe(404);
  });

  it("returns 405 for a known path with another method", async () => {
    const result = parse(await route(createEvent({ method: "POST" })));

    expect(result.statusCode).toBe(405);
  });

  it("passes the verified identity to the handler", async () => {
    mocks.handleMe.mockResolvedValue({ statusCode: 200, body: "{}" });

    await route(createEvent({ path: "/api/me" }));

    expect(mocks.handleMe).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/api/me", identity: IDENTITY }),
    );
  });

  it("returns a generic 500 when a handler throws, without leaking the cause", async () => {
    mocks.handleMe.mockRejectedValue(new Error("database password is wrong"));

    const result = parse(await route(createEvent({ path: "/api/me" })));

    expect(result.statusCode).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain("password");
  });
});
