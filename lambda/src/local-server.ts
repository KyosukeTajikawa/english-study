import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import {
  LAMBDA_ENV_PATH,
  LOCAL_AUDIENCE,
  LOCAL_JWKS_PATH,
  LOCAL_KEY_PATHS,
  LOCAL_TEAM_DOMAIN,
} from "../scripts/local-access.js";
import { provideSecretsForLocal } from "./lib/secrets.js";
import { resolveTestDatabaseUrl } from "./lib/test-database.js";
import { route } from "./router.js";

/**
 * ローカル開発用の HTTP サーバー。`npm run local` で起動する。
 *
 * `sam local start-lambda` は Invoke API の模擬で、HTTP の fetch を受けられない。
 * そこで router.ts を Node の HTTP サーバーで包み、受けたリクエストを
 * Function URL のイベント形状に変換して渡す（doc/steps/04-test-foundation.md の 7）。
 *
 * ★ index.ts を import しないこと。本番の環境検証（Cloudflare 以外の JWKS を拒否）は
 *   index.ts にあり、ここを通らないことでローカルだけテスト鍵を使える。
 *
 * 認証は本番と同じ3段のうち②③をそのまま通す（①の SigV4 は AWS 側の検証なので
 * ここには無い）。X-Internal-Api-Key も JWT も省略できない。違うのは、信頼する
 * 公開鍵がテスト鍵であることと、秘密情報を SSM ではなく lambda/.env から読むことだけ。
 */

const DEFAULT_PORT = 3001;

/** ループバックでのみ待ち受ける。LAN の他の端末から叩けないようにする。 */
const HOST = "127.0.0.1";

function main(): void {
  if (existsSync(LAMBDA_ENV_PATH)) {
    process.loadEnvFile(LAMBDA_ENV_PATH);
  }

  const port = Number(process.env.LOCAL_SERVER_PORT ?? DEFAULT_PORT);
  const jwksBody = readJwks();

  // auth.ts が読む Cloudflare Access の設定を、ローカルの代役に向ける。
  process.env.CF_ACCESS_TEAM_DOMAIN = LOCAL_TEAM_DOMAIN;
  process.env.CF_ACCESS_AUD = LOCAL_AUDIENCE;
  process.env.CF_ACCESS_JWKS_URL = `http://${HOST}:${port}${LOCAL_JWKS_PATH}`;
  process.env.AWS_REGION ??= "local";

  // ★ ローカルでは本番 DB に触れない。Neon のテスト用ブランチを使い、
  //   本番と取り違えていたら起動しない。
  const testDatabaseUrl = resolveTestDatabaseUrl({
    test: process.env.DATABASE_URL_TEST,
    production: [process.env.DATABASE_URL, process.env.DIRECT_URL],
  });
  // 判定が済んだら本番の接続文字列はこのプロセスから消す。誤って読まれないようにする。
  delete process.env.DATABASE_URL;
  delete process.env.DIRECT_URL;

  provideSecretsForLocal({
    INTERNAL_API_KEY: requireEnv("INTERNAL_API_KEY"),
    DATABASE_URL: testDatabaseUrl,
  });

  const server = createServer((request, response) => {
    handleRequest(request, response, jwksBody).catch((cause: unknown) => {
      console.error("local-server failed to handle request", cause);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ ok: false, error: { message: "サーバーでエラーが発生しました。" } }));
    });
  });

  server.listen(port, HOST, () => {
    console.log(`local-server listening on http://${HOST}:${port}`);
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set (lambda/.env を確認してください)`);
  }
  return value;
}

function readJwks(): string {
  if (!existsSync(LOCAL_KEY_PATHS.jwks)) {
    throw new Error("テスト鍵がありません。先に `npm run keys:generate` を実行してください。");
  }
  return readFileSync(LOCAL_KEY_PATHS.jwks, "utf8");
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  jwksBody: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${HOST}`);

  // テスト用の公開鍵。本番で Cloudflare が配信する certs の代わり。
  if (request.method === "GET" && url.pathname === LOCAL_JWKS_PATH) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(jwksBody);
    return;
  }

  const body = await readBody(request);
  const result = await route(toFunctionUrlEvent(request, url, body));
  writeResult(response, result);
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/** Node のリクエストを Lambda Function URL のイベント形状に変換する。 */
function toFunctionUrlEvent(
  request: IncomingMessage,
  url: URL,
  body: Buffer,
): LambdaFunctionURLEvent {
  const method = request.method ?? "GET";
  const now = new Date();

  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: toEventHeaders(request.headers),
    queryStringParameters: url.search ? Object.fromEntries(url.searchParams) : undefined,
    requestContext: {
      accountId: "anonymous",
      apiId: "local",
      domainName: url.host,
      domainPrefix: "local",
      requestId: crypto.randomUUID(),
      routeKey: "$default",
      stage: "$default",
      time: now.toISOString(),
      timeEpoch: now.getTime(),
      http: {
        method,
        path: url.pathname,
        protocol: `HTTP/${request.httpVersion}`,
        sourceIp: request.socket.remoteAddress ?? HOST,
        userAgent: request.headers["user-agent"] ?? "",
      },
    },
    // Function URL と同じく、本文は base64 で渡す（router.ts がデコードする）。
    body: body.length > 0 ? body.toString("base64") : undefined,
    isBase64Encoded: body.length > 0,
  };
}

/** Function URL と同じく、ヘッダ名は小文字・重複値はカンマ区切りにする。 */
function toEventHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const converted: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    converted[name.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  }
  return converted;
}

function writeResult(response: ServerResponse, result: LambdaFunctionURLResult): void {
  // router.ts は常に構造化した結果を返す（文字列だけの省略形は使わない）。
  if (typeof result === "string") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(result);
    return;
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    headers[name] = String(value);
  }
  response.writeHead(result.statusCode ?? 200, headers);

  const body = result.body ?? "";
  response.end(result.isBase64Encoded ? Buffer.from(body, "base64") : body);
}

main();
