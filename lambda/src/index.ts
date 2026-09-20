import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { route } from "./router.js";

/**
 * 本番の唯一のエントリポイント。template.yaml の Handler はこのファイルだけを指す。
 *
 * ★ 設計上の要点 ★
 *
 * ここに置く検証は「本番かどうか」を判定せず**無条件**に実行する。
 * ローカル開発用の local-server.ts は router.ts を直接呼び、このファイルを
 * 一切 import しない。
 *
 * この構造にしている理由:
 *   「本番なら厳格に検証する」という実行時分岐にすると、その判定に使う
 *   フラグ（STAGE / NODE_ENV 等）自体が新たな誤設定リスクになる。
 *   デプロイスクリプトがローカル用の値を本番スタックへ渡した時点で
 *   ガードが無効化され、認証バイパスが復活してしまう。
 *   判定フラグを持たず「本番エントリポイントに置く」ことで構造的に強制する。
 *
 * ステップ3で Cloudflare Access の JWT 検証を追加する際、
 * CF_ACCESS_JWKS_URL が .cloudflareaccess.com 配下であることの検証も
 * ここ（assertEnvironment）に無条件で追加すること。
 */

/**
 * 本番で必ず設定されていなければならない環境変数。
 *
 * 秘密の「値」ではなく「SSM パラメータ名」が入る点に注意。値を環境変数に
 * 置けない理由は lib/secrets.ts の冒頭に書いた。
 */
const REQUIRED_ENV_VARS = [
  "INTERNAL_API_KEY_PARAMETER",
  // ステップ3で追加: "DATABASE_URL", "CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"
] as const;

/**
 * コールドスタート時に環境を検証する。
 * 不備があれば起動を拒否する（フェイルファスト）。
 * 中途半端に動いて認証を素通しするより、全リクエストが失敗する方が安全。
 */
function assertEnvironment(): void {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  // ステップ3で追加する検証の置き場所:
  //
  //   const jwksUrl = process.env.CF_ACCESS_JWKS_URL;
  //   if (jwksUrl && !new URL(jwksUrl).hostname.endsWith(".cloudflareaccess.com")) {
  //     throw new Error("CF_ACCESS_JWKS_URL must point to Cloudflare Access");
  //   }
  //
  // 条件分岐を付けないこと。ローカルは local-server.ts 経由で
  // このファイルを通らないため、本番だけを守れる。
}

assertEnvironment();

export async function handler(
  event: LambdaFunctionURLEvent,
): Promise<LambdaFunctionURLResult> {
  return route(event);
}
