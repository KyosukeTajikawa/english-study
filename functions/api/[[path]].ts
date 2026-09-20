/**
 * Cloudflare Pages Functions — /api/* を AWS Lambda へ中継する。
 *
 * ここは「転送するだけ」に徹する。Workers 無料枠の CPU 10ms/リクエスト
 * 制限が効くのはこの層だけで、重い処理を入れると本番で落ちる。
 *
 * 設計の要点（doc/steps/02-smoke-test.md）:
 *   - レスポンスボディはパースせず素通しする。パース + 再文字列化は
 *     データ量に比例して CPU を消費する。素通しなら一定に保てる。
 *     なお fetch() の応答待ち時間は CPU 時間に算入されない。
 *   - 転送用ヘッダは「新規に組み立てる」。受信ヘッダを複製すると、
 *     クライアントが送った偽の X-Internal-Api-Key が重複ヘッダとして
 *     Lambda に届き、取得実装によっては偽の方が採用されうる。
 */

interface Env {
  /** 中継先の Lambda Function URL。実行時に読まれる。 */
  LAMBDA_FUNCTION_URL: string;
  /** Lambda と共有するシークレット。Lambda 側で最初に検証される。 */
  INTERNAL_API_KEY: string;
  /**
   * ローカル開発用のテスト JWT（.dev.vars から供給）。
   * 本番の Pages にはこの変数を設定しない。設定されている場合のみ、
   * Access のヘッダが無いときのフォールバックとして使う。
   */
  LOCAL_TEST_JWT?: string;
}

/** Cloudflare Access が認証済みリクエストに付けるヘッダ。 */
const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/** Lambda へ転送するヘッダ名。これ以外は引き継がない。 */
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept"] as const;

/** Lambda のレスポンスから引き継ぐヘッダ名。 */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control"] as const;

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (!env.LAMBDA_FUNCTION_URL || !env.INTERNAL_API_KEY) {
    // 設定漏れ。内部情報は返さず、サーバー側のログにのみ残す。
    console.error("relay misconfigured: LAMBDA_FUNCTION_URL or INTERNAL_API_KEY is missing");
    return jsonError(500, "サーバーの設定に問題があります。");
  }

  const accessJwt = request.headers.get(ACCESS_JWT_HEADER) ?? env.LOCAL_TEST_JWT;
  if (!accessJwt) {
    return jsonError(401, "認証が必要です。ページを再読み込みしてください。");
  }

  const target = buildTargetUrl(env.LAMBDA_FUNCTION_URL, new URL(request.url));

  // 受信ヘッダを複製せず、必要なものだけを明示的に組み立てる。
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set(ACCESS_JWT_HEADER, accessJwt);
  headers.set("x-internal-api-key", env.INTERNAL_API_KEY);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody(request.method) ? request.body : undefined,
      // Request のボディをストリームのまま転送する。
      ...(hasBody(request.method) ? { duplex: "half" } : {}),
    } as RequestInit);
  } catch (cause) {
    console.error("relay failed to reach lambda", cause);
    return jsonError(502, "サーバーに接続できませんでした。時間をおいて再度お試しください。");
  }

  // ボディはパースせずストリームのまま返す。
  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
};

/** リクエストのパスとクエリを Function URL に写す。 */
function buildTargetUrl(functionUrl: string, incoming: URL): string {
  const base = new URL(functionUrl);
  base.pathname = incoming.pathname;
  base.search = incoming.search;
  return base.toString();
}

function hasBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
