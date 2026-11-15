import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { AuthenticationError, verifyAccessJwt, type AccessIdentity } from "./lib/auth.js";
import { hasInternalKeyHeader, isValidInternalKey } from "./lib/internal-auth.js";
import { getSecret } from "./lib/secrets.js";
import { fail } from "./lib/response.js";
import { handleHealth } from "./handlers/health.js";
import { handleMe } from "./handlers/me.js";

/**
 * パス → ハンドラの振り分け。
 *
 * Lambda Function URL は1関数に1 URL が対応するだけで、パスによる
 * 振り分け機能を持たない。template.yaml に「ルート」を書く場所はないため、
 * ここで振り分ける。**API を増やすときはこのファイルに登録する。**
 *
 * このモジュールは本番のエントリポイント（index.ts）からも、ローカル用の
 * HTTP サーバー（local-server.ts）からも呼ばれる。そのため環境変数の
 * 事前検証などの副作用をここに置かないこと（index.ts の責務）。
 */

export interface RequestContext {
  method: string;
  path: string;
  /** ヘッダ名は小文字に正規化済み。 */
  headers: Record<string, string | undefined>;
  /** パスパラメータ（例: /api/vocabulary/:id の :id）。 */
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  /** デコード済みのリクエストボディ。無い場合は undefined。 */
  body: string | undefined;
  /**
   * JWT で検証済みの利用者。router が全ルートで無条件に検証してから渡す。
   * userId が要るハンドラは lib/auth.ts の getAuthenticatedUser() で解決する。
   */
  identity: AccessIdentity;
}

type RouteHandler = (
  context: RequestContext,
) => LambdaFunctionURLResult | Promise<LambdaFunctionURLResult>;

interface Route {
  method: string;
  /** ":name" をパラメータとして扱うパスパターン。 */
  pattern: string;
  handler: RouteHandler;
}

const ROUTES: Route[] = [
  { method: "GET", pattern: "/api/health", handler: handleHealth },
  { method: "GET", pattern: "/api/me", handler: handleMe },
];

export async function route(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const headers = normalizeHeaders(event.headers);

  // ヘッダが無いリクエストは、期待値を取得する前にここで落とす。
  // SSM に触れずに済むため、無差別攻撃でスループット上限を消費させられない。
  // 応答は下の不一致時と同一にし、ヘッダの有無を区別させない。
  if (!hasInternalKeyHeader(headers)) {
    return fail(403, "アクセスが拒否されました。");
  }

  // 共有シークレットの検証を全ルート共通で最初に行う。
  // JWT 検証より前に置き、失敗したら DB にも Gemini にも触れない。
  //
  // 期待値は SSM から取得する（環境変数に平文では置けない。secrets.ts 参照）。
  // 初回のみ SSM を呼び、以降はコンテナ内のキャッシュを使う。
  let expectedKey: string;
  try {
    expectedKey = await getSecret("INTERNAL_API_KEY");
  } catch (cause) {
    // 設定不備。素通しは絶対にしない。詳細はログにのみ残す。
    console.error("failed to load INTERNAL_API_KEY from SSM", cause);
    return fail(500, "サーバーの設定に問題があります。");
  }

  if (!isValidInternalKey(headers, expectedKey)) {
    return fail(403, "アクセスが拒否されました。");
  }

  // JWT の検証も全ルート共通・例外なしで行う（CLAUDE.md の必須ルール 1 の③）。
  // ルートの照合より前に置き、認証されていない相手にはどのパスが存在するかも教えない。
  const authResult = await authenticate(headers);
  if (authResult.kind === "unauthenticated") {
    return fail(401, "認証が必要です。ページを再読み込みしてください。");
  }
  if (authResult.kind === "error") {
    return fail(500, "サーバーでエラーが発生しました。");
  }

  const method = event.requestContext.http.method.toUpperCase();
  const path = stripTrailingSlash(event.rawPath);

  const matched = matchRoute(method, path);
  if (matched.kind === "not-found") {
    return fail(404, "エンドポイントが見つかりません。");
  }
  if (matched.kind === "method-not-allowed") {
    return fail(405, "このメソッドは許可されていません。");
  }

  const context: RequestContext = {
    method,
    path,
    headers,
    params: matched.params,
    query: event.queryStringParameters ?? {},
    body: decodeBody(event),
    identity: authResult.identity,
  };

  try {
    return await matched.route.handler(context);
  } catch (cause) {
    // 想定外の例外。詳細はサーバー側のログにのみ残し、UI には汎用メッセージを返す。
    console.error("unhandled error", { method, path, cause });
    return fail(500, "サーバーでエラーが発生しました。");
  }
}

type AuthResult =
  | { kind: "authenticated"; identity: AccessIdentity }
  | { kind: "unauthenticated" }
  | { kind: "error" };

/**
 * JWT を検証し、失敗を「利用者のトークンが悪い（401）」と「こちらの障害（500）」に分ける。
 * どちらの場合も理由はログにのみ残し、応答には含めない。
 */
async function authenticate(headers: Record<string, string | undefined>): Promise<AuthResult> {
  try {
    return { kind: "authenticated", identity: await verifyAccessJwt(headers) };
  } catch (cause) {
    if (cause instanceof AuthenticationError) {
      // 401 は攻撃や期限切れで日常的に起きる。ERROR にするとログが膨らむので WARN にする。
      console.warn("authentication failed", { reason: cause.message });
      return { kind: "unauthenticated" };
    }
    console.error("failed to verify access token", cause);
    return { kind: "error" };
  }
}

type MatchResult =
  | { kind: "matched"; route: Route; params: Record<string, string> }
  | { kind: "method-not-allowed" }
  | { kind: "not-found" };

function matchRoute(method: string, path: string): MatchResult {
  let pathMatched = false;

  for (const route of ROUTES) {
    const params = matchPattern(route.pattern, path);
    if (params === null) continue;

    pathMatched = true;
    if (route.method === method) {
      return { kind: "matched", route, params };
    }
  }

  return pathMatched ? { kind: "method-not-allowed" } : { kind: "not-found" };
}

/** パターンに一致すればパラメータを、しなければ null を返す。 */
function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (const [index, patternPart] of patternParts.entries()) {
    const pathPart = pathParts[index];
    if (pathPart === undefined) return null;

    if (patternPart?.startsWith(":")) {
      const value = safeDecodeURIComponent(pathPart);
      // 空や不正なエンコード（"%E0%A4%A" 等）は「一致しない」= 404 として扱う。
      if (!value) return null;
      params[patternPart.slice(1)] = value;
      continue;
    }
    if (patternPart !== pathPart) return null;
  }
  return params;
}

/** 不正なエンコードで例外を投げる代わりに undefined を返す。 */
function safeDecodeURIComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function normalizeHeaders(
  headers: LambdaFunctionURLEvent["headers"],
): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function decodeBody(event: LambdaFunctionURLEvent): string | undefined {
  if (event.body === undefined || event.body === null) return undefined;
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
