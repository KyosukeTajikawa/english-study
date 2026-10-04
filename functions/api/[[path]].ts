/**
 * Cloudflare Pages Functions — /api/* を AWS Lambda へ中継する。
 *
 * ここは「転送するだけ」に徹する。Workers 無料枠の CPU 10ms/リクエスト
 * 制限が効くのはこの層だけで、重い処理を入れると本番で落ちる。
 *
 * 設計の要点（doc/steps/02-smoke-test.md、doc/steps/03-database.md の 4-3）:
 *   - Lambda Function URL は AuthType: AWS_IAM。**SigV4 署名を付けないと
 *     AWS 側で 403 になり、関数は起動しない。** 無認証リクエストで Lambda を
 *     起動させない（課金させない）ためにこの方式を選んでいる
 *   - レスポンスボディはパースせず素通しする。パース + 再文字列化は
 *     データ量に比例して CPU を消費する。素通しなら一定に保てる。
 *     なお fetch() の応答待ち時間は CPU 時間に算入されない
 *   - 転送用ヘッダは「新規に組み立てる」。受信ヘッダを複製すると、
 *     クライアントが送った偽の X-Internal-Api-Key が重複ヘッダとして
 *     Lambda に届き、取得実装によっては偽の方が採用されうる
 *
 * ★ リクエストボディはストリームできない。
 *   SigV4 は本文の SHA-256 を署名に含めるため、署名前に本文を読み切る
 *   必要がある（duplex: "half" が使えない）。読み切るぶん CPU が本文サイズに
 *   比例するので、MAX_REQUEST_BODY_BYTES で上限を設けている。
 */

import { AwsClient } from "aws4fetch";

interface Env {
  /** 中継先の Lambda Function URL。実行時に読まれる。 */
  LAMBDA_FUNCTION_URL: string;
  /** Lambda と共有するシークレット。Lambda 側で最初に検証される。 */
  INTERNAL_API_KEY: string;
  /** SigV4 署名用。`lambda:InvokeFunctionUrl` のみを持つ IAM ユーザーの鍵。 */
  AWS_ACCESS_KEY_ID: string;
  /** ★ Secret 型で登録する（表示不可）。ネットワークには一度も流れない。 */
  AWS_SECRET_ACCESS_KEY: string;
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

/**
 * 転送するリクエストボディの上限。
 *
 * SigV4 のために本文を読み切るので、上限が無いと CPU とメモリが本文サイズに
 * 引きずられる。単語登録（数百バイト〜数KB）に対して十分な余裕を取りつつ、
 * 10ms 予算を守れる範囲に収める。実測では 512KB の署名で予算の約14%を使う。
 *
 * 将来「単語の一括インポート」を作るなら、ここを上げる前に CPU を実測すること。
 */
const MAX_REQUEST_BODY_BYTES = 128 * 1024;

/** Function URL のホスト名。リージョンの抽出と、転送先の妥当性検証に使う。 */
const FUNCTION_URL_HOST = /^[a-z0-9]+\.lambda-url\.([a-z0-9-]+)\.on\.aws$/;

/**
 * ローカルの local-server.ts を転送先として許可するホスト。
 *
 * `wrangler pages dev` で本番と同じ中継経路を確認するために必要
 * （doc/steps/04-test-foundation.md の 8-2）。
 *
 * ★ これは認証の迂回ではない。署名処理は本番と全く同じ経路を通り、
 *   X-Internal-Api-Key も JWT も同様に要求される。違うのは転送先の
 *   ホストの形だけで、検証を省く分岐はどこにも無い。
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * ループバック宛ての署名に使うリージョン。
 *
 * 実在しない値を意図的に使う。local-server は署名を検証しないので何でも
 * よいが、実在するリージョン名にしておくと、設定を取り違えたときに
 * 本物の AWS へ有効な署名を送れてしまう。ここが実在しなければ、
 * ループバック用の署名は AWS で絶対に通らない。
 */
const LOOPBACK_REGION = "local";

/**
 * 署名クライアントのキャッシュ。
 *
 * aws4fetch は署名キー（秘密鍵と日付から導出する中間値）をインスタンス内の
 * Map に保持する。リクエストごとに new すると毎回 HMAC を4回やり直すことに
 * なり、実測で約2倍のコストになった（0.25ms → 0.49ms）。
 *
 * env はリクエストごとにしか渡されないため、モジュールスコープでの初期化は
 * できない。初回リクエストで作って以降使い回す。値は isolate 内にのみ存在し、
 * リクエスト間で共有されるが、鍵はどのレスポンスにも出ない。
 */
let signerCache: { readonly cacheKey: string; readonly client: AwsClient } | undefined;

function getSigner(env: Env, region: string): AwsClient {
  const cacheKey = `${env.AWS_ACCESS_KEY_ID}\u0000${region}`;
  if (signerCache?.cacheKey === cacheKey) {
    return signerCache.client;
  }
  const client = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    service: "lambda",
    region,
  });
  signerCache = { cacheKey, client };
  return client;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (
    !env.LAMBDA_FUNCTION_URL ||
    !env.INTERNAL_API_KEY ||
    !env.AWS_ACCESS_KEY_ID ||
    !env.AWS_SECRET_ACCESS_KEY
  ) {
    // 設定漏れ。内部情報は返さず、サーバー側のログにのみ残す。
    console.error("relay misconfigured: a required binding is missing");
    return jsonError(500, "サーバーの設定に問題があります。");
  }

  const accessJwt = request.headers.get(ACCESS_JWT_HEADER) ?? env.LOCAL_TEST_JWT;
  if (!accessJwt) {
    return jsonError(401, "認証が必要です。ページを再読み込みしてください。");
  }

  // 転送先を組み立てつつ、Function URL の形をしていることを検証する。
  // ここを検証しないと、LAMBDA_FUNCTION_URL の誤設定で JWT と共有シークレットを
  // 無関係なホストへ送ってしまう（署名はホストを含むので AWS には通らないが、
  // ヘッダの中身は相手に渡る）。
  const target = buildTargetUrl(env.LAMBDA_FUNCTION_URL, new URL(request.url));
  if (target === null) {
    console.error("relay misconfigured: LAMBDA_FUNCTION_URL is not a Lambda Function URL");
    return jsonError(500, "サーバーの設定に問題があります。");
  }

  // ★ SigV4 は本文のハッシュを署名に含めるため、ストリームのままでは署名できない。
  // 先に上限を確認し、超えるものは読まずに拒否する。
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length > MAX_REQUEST_BODY_BYTES) {
      return jsonError(413, "送信されたデータが大きすぎます。");
    }
  }

  let body: ArrayBuffer | undefined;
  if (hasBody(request.method)) {
    body = await request.arrayBuffer();
    // content-length が無い（chunked）場合はここが唯一の歯止めになる。
    if (body.byteLength > MAX_REQUEST_BODY_BYTES) {
      return jsonError(413, "送信されたデータが大きすぎます。");
    }
  }

  // 受信ヘッダを複製せず、必要なものだけを明示的に組み立てる。
  // host は aws4fetch が URL から付けるので、ここでは設定しない。
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set(ACCESS_JWT_HEADER, accessJwt);
  headers.set("x-internal-api-key", env.INTERNAL_API_KEY);

  let upstream: Response;
  try {
    // sign() は署名済みの Request を返す。client.fetch() は使わない
    // （内部のリトライが入ると、失敗時の待ち時間と挙動が読めなくなる）。
    const signed = await getSigner(env, target.region).sign(target.url, {
      method: request.method,
      headers,
      body,
    });
    upstream = await fetch(signed);
  } catch (cause) {
    console.error("relay failed to reach lambda", cause);
    return jsonError(502, "サーバーに接続できませんでした。時間をおいて再度お試しください。");
  }

  // ボディはパースせずストリームのまま返す（レスポンスは署名対象ではない）。
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

/**
 * リクエストのパスとクエリを Function URL に写し、リージョンを取り出す。
 *
 * Function URL の形（`<id>.lambda-url.<region>.on.aws`）か、ローカルの
 * ループバックでなければ null を返す。
 *
 * リージョンは署名に必要だが、環境変数にはしない。URL とリージョンが
 * 食い違う誤設定を作れてしまい、本番で原因の分かりにくい 403 になるため、
 * ホスト名から導く（この2つは構造的に食い違えない）。
 */
function buildTargetUrl(
  functionUrl: string,
  incoming: URL,
): { url: string; region: string } | null {
  let base: URL;
  try {
    base = new URL(functionUrl);
  } catch {
    return null;
  }

  base.pathname = incoming.pathname;
  base.search = incoming.search;

  const matched = FUNCTION_URL_HOST.exec(base.hostname);
  if (matched?.[1] !== undefined) {
    if (base.protocol !== "https:") return null;
    return { url: base.toString(), region: matched[1] };
  }

  // ローカルの local-server。署名は付けるが相手が検証しない（上記の注記参照）。
  if (LOOPBACK_HOSTS.has(base.hostname)) {
    return { url: base.toString(), region: LOOPBACK_REGION };
  }

  return null;
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
