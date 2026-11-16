import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * secrets.ts のテスト。SSM クライアントはモックし、取得結果の検証と
 * キャッシュ（コールドスタート時の1回だけ呼ぶ）を確かめる。
 */

const send = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    send = send;
  },
  GetParametersCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

type SecretsModule = typeof import("../secrets.js");

const PARAMETERS = {
  INTERNAL_API_KEY: "/english-study-app/internal-api-key",
  DATABASE_URL: "/english-study-app/database-url",
};

/** secrets.ts は取得結果をモジュールスコープにキャッシュする。テストごとに読み込み直す。 */
async function loadSecrets(): Promise<SecretsModule> {
  vi.resetModules();
  return import("../secrets.js");
}

function ssmResponse(values: Partial<Record<keyof typeof PARAMETERS, string>>) {
  return {
    Parameters: Object.entries(values).map(([name, value]) => ({
      Name: PARAMETERS[name as keyof typeof PARAMETERS],
      Value: value,
    })),
    InvalidParameters: [],
  };
}

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("INTERNAL_API_KEY_PARAMETER", PARAMETERS.INTERNAL_API_KEY);
  vi.stubEnv("DATABASE_URL_PARAMETER", PARAMETERS.DATABASE_URL);
});

describe("getSecret", () => {
  it("fetches all secrets from SSM once and serves later reads from the cache", async () => {
    // Arrange
    const { getSecret } = await loadSecrets();
    send.mockResolvedValue(ssmResponse({ INTERNAL_API_KEY: "key", DATABASE_URL: "postgres://db" }));

    // Act
    const key = await getSecret("INTERNAL_API_KEY");
    const url = await getSecret("DATABASE_URL");

    // Assert
    expect(key).toBe("key");
    expect(url).toBe("postgres://db");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: { Names: [PARAMETERS.INTERNAL_API_KEY, PARAMETERS.DATABASE_URL], WithDecryption: true },
    });
  });

  it("fails when a parameter name environment variable is missing", async () => {
    const { getSecret } = await loadSecrets();
    vi.stubEnv("DATABASE_URL_PARAMETER", "");

    await expect(getSecret("INTERNAL_API_KEY")).rejects.toThrow("DATABASE_URL_PARAMETER");
    expect(send).not.toHaveBeenCalled();
  });

  it("fails when SSM reports a parameter as invalid", async () => {
    const { getSecret } = await loadSecrets();
    send.mockResolvedValue({ Parameters: [], InvalidParameters: [PARAMETERS.DATABASE_URL] });

    await expect(getSecret("INTERNAL_API_KEY")).rejects.toThrow("SSM parameters not found");
  });

  it("fails when SSM returns no value for a secret", async () => {
    const { getSecret } = await loadSecrets();
    send.mockResolvedValue(ssmResponse({ INTERNAL_API_KEY: "key" }));

    await expect(getSecret("INTERNAL_API_KEY")).rejects.toThrow("SSM returned no value for: DATABASE_URL");
  });

  it("retries after a failure instead of caching the error", async () => {
    const { getSecret } = await loadSecrets();
    send
      .mockRejectedValueOnce(new Error("throttled"))
      .mockResolvedValueOnce(ssmResponse({ INTERNAL_API_KEY: "key", DATABASE_URL: "postgres://db" }));

    await expect(getSecret("INTERNAL_API_KEY")).rejects.toThrow("throttled");
    await expect(getSecret("INTERNAL_API_KEY")).resolves.toBe("key");
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("provideSecretsForLocal", () => {
  it("serves the given values without calling SSM", async () => {
    const { getSecret, provideSecretsForLocal } = await loadSecrets();

    provideSecretsForLocal({ INTERNAL_API_KEY: "local-key", DATABASE_URL: "postgres://test" });

    await expect(getSecret("DATABASE_URL")).resolves.toBe("postgres://test");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects empty values", async () => {
    const { provideSecretsForLocal } = await loadSecrets();

    expect(() => provideSecretsForLocal({ INTERNAL_API_KEY: "local-key", DATABASE_URL: "" })).toThrow(
      "Missing local secrets: DATABASE_URL",
    );
  });
});
