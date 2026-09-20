/**
 * ★★★ 一時的な検証コード。ステップ2の完了時にこのファイルごと削除する。★★★
 *
 * 目的（doc/steps/02-smoke-test.md の検証3）:
 *   「東京リージョンの Lambda の IP から Gemini API を呼べるか」を確かめる。
 *   Gemini は呼び出し元 IP のリージョンで制限されるため、ローカル（自宅の IP）
 *   で成功しても意味がない。デプロイした Lambda から実行して初めて判断できる。
 *   ここが失敗する場合、Lambda に処理を寄せる構成そのものが成立しない。
 *
 * 削除手順:
 *   1. このファイルを削除する
 *   2. router.ts の ROUTES から該当行と import を削除する
 *   3. template.yaml の GEMINI_API_KEY 環境変数と GeminiApiKeyParameter を削除する
 *   4. sam build && sam deploy で再デプロイする
 *
 * 残してはいけない理由: 認証を通らないエンドポイントから Gemini を消費できる
 * 経路が本番に残る。無料枠を使い切らされる。
 */

import type { LambdaFunctionURLResult } from "aws-lambda";
import { GoogleGenAI } from "@google/genai";
import { getSecret } from "../lib/secrets.js";
import { ok, fail } from "../lib/response.js";

/**
 * 検証に使うモデル。本番で使うモデルはステップ6で決めるため、ここは暫定。
 *
 * gemini-2.5-flash-lite は「新規ユーザーには提供しない」状態になっており、
 * 404 で次のように案内される（実測）:
 *   This model models/gemini-2.5-flash-lite is no longer available to new
 *   users. Please update your code to use models/gemini-3.5-flash-lite
 * モデル一覧 API に出ていても呼べるとは限らない点に注意。
 */
const SMOKE_TEST_MODEL = "gemini-3.5-flash-lite";

/** Lambda 自体のタイムアウト（10秒）より短くし、原因の分かる形で失敗させる。 */
const GEMINI_TIMEOUT_MS = 8_000;

/** 応答が返ることだけ確認できればよいので、最小の問いにする。 */
const SMOKE_TEST_PROMPT = 'Reply with exactly one word: "ok"';

interface GeminiSmokeData {
  reachable: true;
  model: string;
  /** Lambda が動いているリージョン。東京であることの確認用。 */
  region: string;
  /** モデルの応答（先頭のみ）。疎通の証拠として返す。 */
  reply: string;
  elapsedMs: number;
}

export async function handleGeminiSmoke(): Promise<LambdaFunctionURLResult> {
  let apiKey: string;
  try {
    // 環境変数ではなく SSM から取得する（secrets.ts の冒頭コメント参照）。
    apiKey = await getSecret("GEMINI_API_KEY");
  } catch (cause) {
    return fail(500, `Gemini API キーを取得できませんでした: ${describeError(cause)}`);
  }

  const startedAt = Date.now();

  try {
    const reply = await callGemini(apiKey);
    const data: GeminiSmokeData = {
      reachable: true,
      model: SMOKE_TEST_MODEL,
      region: process.env.AWS_REGION ?? "unknown",
      reply: reply.slice(0, 100),
      elapsedMs: Date.now() - startedAt,
    };
    return ok(data);
  } catch (cause) {
    // 検証用ハンドラなので、切り分けに必要な情報はレスポンスに載せる。
    // 本番用の API では内部エラーを返さないこと（このファイルは削除する）。
    return fail(502, `Gemini の呼び出しに失敗しました: ${describeError(cause)}`);
  }
}

async function callGemini(apiKey: string): Promise<string> {
  const client = new GoogleGenAI({ apiKey });

  const request = client.models.generateContent({
    model: SMOKE_TEST_MODEL,
    contents: SMOKE_TEST_PROMPT,
  });

  const response = await withTimeout(request, GEMINI_TIMEOUT_MS);
  return response.text ?? "(empty response)";
}

/** SDK のバージョン差に依存しないよう、タイムアウトは自前で被せる。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/** 例外から、原因の切り分けに使える一行を取り出す。 */
function describeError(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}
