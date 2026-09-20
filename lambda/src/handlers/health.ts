import type { LambdaFunctionURLResult } from "aws-lambda";
import type { HealthData } from "@shared/types";
import { ok } from "../lib/response.js";

/**
 * 疎通確認用のハンドラ。
 *
 * ステップ2でデプロイ経路を通すためだけに存在する。
 * **DB にも Gemini にも触れないこと。** 一時的に Gemini の疎通確認を
 * ここに書く場合も、確認が済んだら必ず削除する（ステップ2の注意点）。
 */
export function handleHealth(): LambdaFunctionURLResult {
  const data: HealthData = {
    status: "ok",
    region: process.env.AWS_REGION ?? "unknown",
    runtime: process.version,
    timestamp: new Date().toISOString(),
  };
  return ok(data);
}
