import type { LambdaFunctionURLResult } from "aws-lambda";
import type { ApiError, ApiResponse } from "@shared/types";

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** 成功レスポンス。 */
export function ok<T>(data: T, statusCode = 200): LambdaFunctionURLResult {
  return json({ ok: true, data }, statusCode);
}

/**
 * 失敗レスポンス。
 *
 * message は利用者に見せる文言に限る。スタックトレースや DB のエラー文を
 * 混ぜないこと（内部情報の漏洩になる）。詳細はサーバー側のログに残す。
 */
export function fail(
  statusCode: number,
  message: string,
  fields?: ApiError["fields"],
): LambdaFunctionURLResult {
  return json({ ok: false, error: fields ? { message, fields } : { message } }, statusCode);
}

function json<T>(body: ApiResponse<T>, statusCode: number): LambdaFunctionURLResult {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}
