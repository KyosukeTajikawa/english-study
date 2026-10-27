import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { z } from "zod";
import type { PrismaClient } from "./db.js";
import { upsertUserByEmail, type UserRecord } from "../repositories/user.js";

/**
 * Cloudflare Access の JWT 検証とユーザー解決。**このアプリの認証の本体。**
 *
 * Function URL は AWS_IAM で守られているが、IAM の誤設定や鍵の漏洩に備えて
 * ここでも必ず検証する（CLAUDE.md の必須ルール 1）。ヘッダの中身をそのまま
 * 信じると、誰でも任意のメールアドレスを名乗れる。
 *
 * 処理は2段に分かれている:
 *   1. verifyAccessJwt()      … 署名・aud・iss・exp を検証し email を取り出す。
 *                               DB に触れない。router.ts が全ルートで無条件に呼ぶ
 *   2. getAuthenticatedUser() … 検証済みの email で User を upsert し userId を返す。
 *                               ユーザーのデータを扱うハンドラが呼ぶ
 *
 * 1 を router に置くことで、ハンドラが JWT 検証を呼び忘れる余地を無くしている。
 * 2 を呼び忘れたハンドラは userId を持たないため、userId スコープの
 * リポジトリ関数を呼べない（CLAUDE.md の必須ルール 4）。
 *
 * ★ 「開発中は検証をスキップする」フラグは作らない。消し忘れが認証バイパスになる。
 *   ローカルでは CF_ACCESS_JWKS_URL でテスト用の鍵に差し替え、検証ロジック自体は
 *   本番と同一に保つ（doc/steps/03-database.md の 4）。
 */

/** Cloudflare Access が認証済みリクエストに付けるヘッダ。 */
const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/** Cloudflare Access の署名アルゴリズム。これ以外（none 等）は受け付けない。 */
const ALLOWED_ALGORITHMS = ["RS256"];

/** Cloudflare と Lambda の時計のずれの許容幅。 */
const CLOCK_TOLERANCE_SECONDS = 30;

/** 認証に失敗した（401 を返すべき）ことを表す。理由はログにのみ残す。 */
export class AuthenticationError extends Error {
  override readonly name = "AuthenticationError";
}

/** JWT から取り出した、検証済みの利用者情報。 */
export interface AccessIdentity {
  email: string;
}

/**
 * 認証済みのユーザー。ハンドラはこの userId でデータを絞る。
 * 設定値も含めるのは、それを使うハンドラが User をもう一度引かずに済むようにするため。
 */
export type AuthenticatedUser = { userId: string } & Omit<UserRecord, "id">;

/**
 * JWT のペイロードのうち、このアプリが使う部分。
 *
 * サービストークン（機械アクセス）の JWT は email を持たない。
 * このアプリは人のログインだけを想定しているので、email の無いトークンは拒否する。
 */
const accessClaimsSchema = z.object({
  email: z.email().transform((email) => email.toLowerCase()),
});

interface AccessConfig {
  issuer: string;
  audience: string;
  jwksUrl: URL;
}

/**
 * 環境変数から検証の設定を組み立てる。
 *
 * 値の形（Cloudflare のドメインであること）は index.ts の assertEnvironment() が
 * コールドスタート時に検証済み。ここでは欠落だけを見る。
 */
function loadAccessConfig(): AccessConfig {
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
  const audience = process.env.CF_ACCESS_AUD;
  if (!teamDomain || !audience) {
    // 入れ忘れは全 API が 401 になる（安全側）。原因はログで分かるようにする。
    throw new Error("CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set");
  }

  const issuer = `https://${teamDomain}`;
  const jwksUrl = new URL(process.env.CF_ACCESS_JWKS_URL ?? `${issuer}/cdn-cgi/access/certs`);
  return { issuer, audience, jwksUrl };
}

/**
 * 公開鍵セットのキャッシュ。
 *
 * createRemoteJWKSet は取得した鍵を内部にキャッシュし、未知の kid が来たときだけ
 * 取り直す。モジュールスコープに置けば、コンテナが生きている間は再取得しない。
 */
let verifierCache:
  | { readonly config: AccessConfig; readonly jwks: ReturnType<typeof createRemoteJWKSet> }
  | undefined;

function getVerifier(): NonNullable<typeof verifierCache> {
  if (verifierCache) return verifierCache;

  const config = loadAccessConfig();
  verifierCache = { config, jwks: createRemoteJWKSet(config.jwksUrl) };
  return verifierCache;
}

/**
 * cf-access-jwt-assertion を検証し、利用者の email を返す。
 *
 * @throws AuthenticationError ヘッダの欠落、署名・aud・iss・exp の不一致、email の欠落
 * @throws Error 公開鍵を取得できないなど、利用者のせいではない失敗（500 にすべきもの）
 */
export async function verifyAccessJwt(
  headers: Record<string, string | undefined>,
): Promise<AccessIdentity> {
  const token = headers[ACCESS_JWT_HEADER];
  if (!token) {
    throw new AuthenticationError("missing access token");
  }

  const { config, jwks } = getVerifier();

  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      // ★ aud を検証しないと、同じ Cloudflare チームの別アプリ向けトークンでも通る。
      audience: config.audience,
      // 署名・aud に加えて発行者も確認する（多層で確認する）。
      issuer: config.issuer,
      algorithms: ALLOWED_ALGORITHMS,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    }));
  } catch (cause) {
    throw toAuthenticationError(cause);
  }

  const claims = accessClaimsSchema.safeParse(payload);
  if (!claims.success) {
    throw new AuthenticationError("access token has no valid email claim");
  }
  return { email: claims.data.email };
}

/**
 * トークン自体が不正であることを表す jose の例外。これらだけを 401 にする。
 *
 * ★ 「こちらの障害」を除外するのではなく「利用者の誤り」を列挙している。
 *   jose は公開鍵の取得先が 200 以外を返したとき、専用のクラスではなく
 *   素の JOSEError（ERR_JOSE_GENERIC）を投げる。除外方式だとそれが 401 になり、
 *   Cloudflare の障害なのに「ログインし直してください」と案内してしまう。
 */
const CLIENT_SIDE_ERRORS = [
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];

/** jose の例外を「利用者のトークンが悪い（401）」と「こちらの障害（500）」に振り分ける。 */
function toAuthenticationError(cause: unknown): unknown {
  const isClientSide = CLIENT_SIDE_ERRORS.some((errorClass) => cause instanceof errorClass);
  if (isClientSide) {
    return new AuthenticationError(`invalid access token: ${(cause as errors.JOSEError).code}`);
  }
  return cause;
}

/**
 * 検証済みの利用者に対応する User を解決する（無ければ作る）。
 *
 * ★ identity は verifyAccessJwt() の戻り値（router.ts が渡す context.identity）
 *   以外から作らないこと。
 */
export async function getAuthenticatedUser(
  db: PrismaClient,
  identity: AccessIdentity,
): Promise<AuthenticatedUser> {
  const { id, ...rest } = await upsertUserByEmail(db, identity.email);
  return { userId: id, ...rest };
}
