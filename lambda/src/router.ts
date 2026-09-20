import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { isValidInternalKey } from "./lib/internal-auth.js";
import { getSecret } from "./lib/secrets.js";
import { fail } from "./lib/response.js";
import { handleHealth } from "./handlers/health.js";
// ★ ステップ2の疎通確認専用。確認後にこの import と下の ROUTES 行を削除する。
import { handleGeminiSmoke } from "./handlers/_gemini-smoke.js";

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
  // ★ ステップ2の疎通確認専用。確認後に削除する（_gemini-smoke.ts ごと）。
  { method: "GET", pattern: "/api/_gemini-smoke", handler: handleGeminiSmoke },
];

export async function route(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const headers = normalizeHeaders(event.headers);

  // 共有シークレットの検証を全ルート共通で最初に行う。
  // JWT 検証（ステップ3）より前に置き、失敗したら DB にも Gemini にも触れない。
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
  };

  try {
    return await matched.route.handler(context);
  } catch (cause) {
    // 想定外の例外。詳細はサーバー側のログにのみ残し、UI には汎用メッセージを返す。
    console.error("unhandled error", { method, path, cause });
    return fail(500, "サーバーでエラーが発生しました。");
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
      if (pathPart === "") return null;
      params[patternPart.slice(1)] = decodeURIComponent(pathPart);
      continue;
    }
    if (patternPart !== pathPart) return null;
  }
  return params;
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
