import { createSign, generateKeyPairSync } from "node:crypto";
import { expect, test } from "@playwright/test";

/**
 * 疎通確認。本番と同じ中継経路（Pages Functions → Lambda）で認証が働くことを確かめる。
 *
 * 正規の JWT は .dev.vars の LOCAL_TEST_JWT を中継が付ける（ヘッダが無いときの代わり）。
 * リクエストにヘッダを付ければ、中継はそちらを優先して転送する。
 */

/** lambda/scripts/local-access.ts と同じ値。署名だけが不正なトークンを作るために使う。 */
const LOCAL_ISSUER = "https://local-access.invalid";
const LOCAL_AUDIENCE = "english-study-app-local";
const LOCAL_KEY_ID = "local-test-key";

const ONE_HOUR_SECONDS = 60 * 60;

/** 中身はローカルの設定どおりで、署名だけが信頼されていない鍵のトークン。 */
function signWithUntrustedKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);

  const signingInput = [
    encode({ alg: "RS256", kid: LOCAL_KEY_ID }),
    encode({
      email: "attacker@example.com",
      iss: LOCAL_ISSUER,
      aud: LOCAL_AUDIENCE,
      iat: now,
      exp: now + ONE_HOUR_SECONDS,
    }),
  ].join(".");
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey, "base64url");
  return `${signingInput}.${signature}`;
}

test("the browser reaches /api/health through the Pages Functions relay", async ({ page }) => {
  // Arrange
  await page.goto("/");

  // Act: 画面と同じく、ブラウザから相対パスで叩く。
  const response = await page.evaluate(async () => {
    const result = await fetch("/api/health");
    return { status: result.status, body: await result.json() };
  });

  // Assert
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ ok: true, data: { status: "ok" } });
});

test("a token signed by an untrusted key is rejected with 401", async ({ request }) => {
  const response = await request.get("/api/health", {
    headers: { "cf-access-jwt-assertion": signWithUntrustedKey() },
  });

  expect(response.status()).toBe(401);
  expect(await response.json()).toMatchObject({ ok: false });
});

test("/api/me returns the signed-in user from the test database", async ({ request }) => {
  const response = await request.get("/api/me");

  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.data.email).toMatch(/@/);
  // 内部の ID はブラウザに渡さない。
  expect(body.data).not.toHaveProperty("id");
});
