import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../db.js";
import type { UserRecord } from "../../repositories/user.js";

/**
 * lib/auth.ts のテスト。このアプリの認証の本体なので、拒否すべきトークンを網羅する。
 *
 * 公開鍵は本番と同じく HTTP で取得させる（createRemoteJWKSet をモックしない）。
 * テスト用の鍵ペアをその場で作り、ローカルの HTTP サーバーから配信する。
 * 検証ロジックは本番と同一で、信頼する鍵だけが違う（doc/steps/04-test-foundation.md の 7）。
 */

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const ISSUER = `https://${TEAM_DOMAIN}`;
const AUDIENCE = "test-audience";
const KEY_ID = "test-key";
const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

const ONE_HOUR_SECONDS = 60 * 60;
/** auth.ts の時計ずれの許容幅（30秒）を十分に超える過去。 */
const EXPIRED_SECONDS_AGO = 5 * 60;

type AuthModule = typeof import("../auth.js");

let trustedKey: CryptoKey;
let untrustedKey: CryptoKey;
let trustedPublicJwk: JWK;
let jwksServer: Server;
let jwksUrl: string;
/** JWKS エンドポイントが返す HTTP ステータス。障害の再現に使う。 */
let jwksStatus = 200;

beforeAll(async () => {
  const trusted = await generateKeyPair("RS256");
  const untrusted = await generateKeyPair("RS256");
  trustedKey = trusted.privateKey;
  untrustedKey = untrusted.privateKey;

  trustedPublicJwk = { ...(await exportJWK(trusted.publicKey)), kid: KEY_ID, alg: "RS256" };
  const jwksBody = JSON.stringify({ keys: [trustedPublicJwk] });

  jwksServer = createServer((_request, response) => {
    response.writeHead(jwksStatus, { "content-type": "application/json" });
    response.end(jwksStatus === 200 ? jwksBody : "{}");
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  const { port } = jwksServer.address() as AddressInfo;
  jwksUrl = `http://127.0.0.1:${port}/cdn-cgi/access/certs`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    jwksServer.close((error) => (error ? reject(error) : resolve())),
  );
});

/**
 * auth.ts は公開鍵セットをモジュールスコープにキャッシュする。
 * テストごとに読み込み直し、前のテストの設定や鍵を持ち越さない。
 */
async function loadAuth(): Promise<AuthModule> {
  vi.resetModules();
  return import("../auth.js");
}

beforeEach(() => {
  jwksStatus = 200;
  vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", TEAM_DOMAIN);
  vi.stubEnv("CF_ACCESS_AUD", AUDIENCE);
  vi.stubEnv("CF_ACCESS_JWKS_URL", jwksUrl);
});

interface TokenOptions {
  key?: CryptoKey;
  claims?: Record<string, unknown>;
  audience?: string;
  issuer?: string;
  /** 発行時刻からの有効期限。負の値で期限切れのトークンを作る。 */
  expiresInSeconds?: number;
}

async function signToken(options: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = options.expiresInSeconds ?? ONE_HOUR_SECONDS;
  return new SignJWT({ email: "learner@example.com", ...options.claims })
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(now - Math.max(0, -expiresIn) - 1)
    .setExpirationTime(now + expiresIn)
    .sign(options.key ?? trustedKey);
}

function encodeSegment(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function headersWith(token: string): Record<string, string> {
  return { [ACCESS_JWT_HEADER]: token };
}

describe("verifyAccessJwt", () => {
  it("returns the email when the token is valid", async () => {
    // Arrange
    const { verifyAccessJwt } = await loadAuth();
    const token = await signToken();

    // Act
    const identity = await verifyAccessJwt(headersWith(token));

    // Assert
    expect(identity).toEqual({ email: "learner@example.com" });
  });

  it("normalizes the email to lower case", async () => {
    const { verifyAccessJwt } = await loadAuth();
    const token = await signToken({ claims: { email: "Learner@Example.COM" } });

    const identity = await verifyAccessJwt(headersWith(token));

    expect(identity.email).toBe("learner@example.com");
  });

  it("rejects a request without the access token header", async () => {
    const { verifyAccessJwt, AuthenticationError } = await loadAuth();

    const result = verifyAccessJwt({});

    // jose に渡しても不正なトークンとして 401 になるが、ここでは渡す前に止める
    // （理由をログで区別できるようにするため）。
    await expect(result).rejects.toBeInstanceOf(AuthenticationError);
    await expect(result).rejects.toThrow("missing access token");
  });

  it("rejects a token signed by an untrusted key", async () => {
    const { verifyAccessJwt, AuthenticationError } = await loadAuth();
    // kid は信頼する鍵と同じにし、署名の検証そのもので落ちることを確かめる。
    const token = await signToken({ key: untrustedKey });

    await expect(verifyAccessJwt(headersWith(token))).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects a token whose signature was tampered with", async () => {
    const { verifyAccessJwt, AuthenticationError } = await loadAuth();
    const [header, , signature] = (await signToken()).split(".");
    // 署名以外の検証（aud・iss・exp）はすべて通る中身にし、署名だけで落ちることを確かめる。
    const now = Math.floor(Date.now() / 1000);
    const forgedPayload = encodeSegment({
      email: "attacker@example.com",
      aud: AUDIENCE,
      iss: ISSUER,
      iat: now,
      exp: now + ONE_HOUR_SECONDS,
    });

    const forged = `${header}.${forgedPayload}.${signature}`;

    await expect(verifyAccessJwt(headersWith(forged))).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects an unsigned token (alg: none)", async () => {
    const { verifyAccessJwt, AuthenticationError } = await loadAuth();
    const now = Math.floor(Date.now() / 1000);
    const unsigned = [
      encodeSegment({ alg: "none", kid: KEY_ID }),
      encodeSegment({ email: "attacker@example.com", aud: AUDIENCE, iss: ISSUER, exp: now + ONE_HOUR_SECONDS }),
      "",
    ].join(".");

    await expect(verifyAccessJwt(headersWith(unsigned))).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects a token signed with a symmetric algorithm (HS256)", async () => {
    const { verifyAccessJwt, AuthenticationError } = await loadAuth();
    // 公開鍵を HMAC の秘密として使う古典的な攻撃。RS256 以外は受け付けないこと。
    const token = await new SignJWT({ email: "attacker@example.com" })
      .setProtectedHeader({ alg: "HS256", kid: KEY_ID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(JSON.stringify(trustedPublicJwk)));

    await expect(verifyAccessJwt(headersWith(token))).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects an expired token", async () => {
    const { verifyAccessJwt, AuthenticationError } = await loadAuth();
    const token = await signToken({ expiresInSeconds: -EXPIRED_SECONDS_AGO });

    await expect(verifyAccessJwt(headersWith(token))).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects a token issued for a different audience", async () => {
    const { verifyAccessJwt, AuthenticationError } = await loadAuth();
    const token = await signToken({ audience: "another-application" });

    await expect(verifyAccessJwt(headersWith(token))).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects a token from a different issuer", async () => {
    const { verifyAccessJwt, AuthenticationError } = await loadAuth();
    const token = await signToken({ issuer: "https://another-team.cloudflareaccess.com" });

    await expect(verifyAccessJwt(headersWith(token))).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects a token that is not a JWT", async () => {
    const { verifyAccessJwt, AuthenticationError } = await loadAuth();

    await expect(verifyAccessJwt(headersWith("not-a-jwt"))).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("rejects a token without an email claim (service token)", async () => {
    const { verifyAccessJwt, AuthenticationError } = await loadAuth();
    const token = await signToken({ claims: { email: undefined, common_name: "service" } });

    await expect(verifyAccessJwt(headersWith(token))).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("treats a JWKS outage as a server error, not as an authentication failure", async () => {
    const { verifyAccessJwt, AuthenticationError } = await loadAuth();
    const token = await signToken();
    jwksStatus = 503;

    const result = verifyAccessJwt(headersWith(token));

    // 401 にすると「ログインし直して」と案内してしまう。500 にすべき失敗。
    await expect(result).rejects.toThrow();
    await expect(result).rejects.not.toBeInstanceOf(AuthenticationError);
  });

  it("fails when the Cloudflare Access settings are missing", async () => {
    const { verifyAccessJwt, AuthenticationError } = await loadAuth();
    vi.stubEnv("CF_ACCESS_AUD", "");
    const token = await signToken();

    const result = verifyAccessJwt(headersWith(token));

    await expect(result).rejects.toThrow("CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set");
    await expect(result).rejects.not.toBeInstanceOf(AuthenticationError);
  });
});

/**
 * User テーブルの最小限のフェイク。email の一意制約と upsert の意味だけを再現する。
 * リポジトリ関数は db を引数で受け取るので、実 DB なしでここに差し替えられる。
 */
function createFakeDb(): { db: PrismaClient; users: () => UserRecord[] } {
  const rows = new Map<string, UserRecord>();

  const user = {
    upsert: async ({ where, create }: { where: { email: string }; create: { email: string } }) => {
      const existing = rows.get(where.email);
      if (existing) return existing;

      const created: UserRecord = {
        id: `user-${rows.size + 1}`,
        email: create.email,
        timezone: "Asia/Tokyo",
        notificationTime: "07:00",
      };
      rows.set(where.email, created);
      return created;
    },
  };

  return { db: { user } as unknown as PrismaClient, users: () => [...rows.values()] };
}

describe("getAuthenticatedUser", () => {
  it("creates the user on first access and returns its id as userId", async () => {
    const { getAuthenticatedUser } = await loadAuth();
    const { db, users } = createFakeDb();

    const user = await getAuthenticatedUser(db, { email: "learner@example.com" });

    expect(user).toEqual({
      userId: "user-1",
      email: "learner@example.com",
      timezone: "Asia/Tokyo",
      notificationTime: "07:00",
    });
    expect(users()).toHaveLength(1);
  });

  it("does not create a duplicate user when called twice with the same email", async () => {
    const { verifyAccessJwt, getAuthenticatedUser } = await loadAuth();
    const { db, users } = createFakeDb();
    // 大文字小文字が違っても同じ人として扱われることも確かめる。
    const first = await verifyAccessJwt(headersWith(await signToken()));
    const second = await verifyAccessJwt(
      headersWith(await signToken({ claims: { email: "LEARNER@example.com" } })),
    );

    const firstUser = await getAuthenticatedUser(db, first);
    const secondUser = await getAuthenticatedUser(db, second);

    expect(secondUser.userId).toBe(firstUser.userId);
    expect(users()).toHaveLength(1);
  });
});
