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
 * CF_ACCESS_JWKS_URL が Cloudflare Access を指していることの検証も
 * ここ（assertEnvironment）に無条件で置いている。
 */

/**
 * 本番で必ず設定されていなければならない環境変数。
 *
 * 秘密の「値」ではなく「SSM パラメータ名」が入る点に注意。値を環境変数に
 * 置けない理由は lib/secrets.ts の冒頭に書いた。
 */
const REQUIRED_ENV_VARS = [
  "INTERNAL_API_KEY_PARAMETER",
  "DATABASE_URL_PARAMETER",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
] as const;

/** Cloudflare Access の発行元・公開鍵配布元のドメイン。 */
const CLOUDFLARE_ACCESS_DOMAIN_SUFFIX = ".cloudflareaccess.com";

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

  // ★ JWKS URL がテスト用の鍵を指したまま本番に出ると、テスト鍵で署名した
  //   任意の JWT が通る（認証バイパス）。Cloudflare 以外を指していたら起動を拒否する。
  //   チームドメインも同様に検証する（発行者と既定の JWKS URL はここから作られる）。
  //
  // 条件分岐を付けないこと。ローカルは local-server.ts 経由で
  // このファイルを通らないため、本番だけを守れる。
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN ?? "";
  const teamUrl = assertCloudflareAccessHost("CF_ACCESS_TEAM_DOMAIN", `https://${teamDomain}`);
  // パス・ポート・ユーザー情報の混入を拒否する（ホスト名だけであること）。
  if (teamUrl.host !== teamDomain) {
    throw new Error("CF_ACCESS_TEAM_DOMAIN must be a bare host name");
  }

  // *.cloudflareaccess.com は誰でもチームを作れる。自分のチーム以外の鍵を
  // 信頼しないよう、JWKS の取得先はチームドメインと完全一致させる。
  const jwksUrl = process.env.CF_ACCESS_JWKS_URL;
  if (jwksUrl !== undefined) {
    const url = assertCloudflareAccessHost("CF_ACCESS_JWKS_URL", jwksUrl);
    if (url.host !== teamDomain) {
      throw new Error("CF_ACCESS_JWKS_URL must be on CF_ACCESS_TEAM_DOMAIN");
    }
  }
}

/** URL が https の Cloudflare Access のホストを指していなければ例外を投げる。 */
function assertCloudflareAccessHost(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL or host name`);
  }

  const isCloudflareAccess =
    url.protocol === "https:" && url.hostname.endsWith(CLOUDFLARE_ACCESS_DOMAIN_SUFFIX);
  if (!isCloudflareAccess) {
    throw new Error(`${name} must point to Cloudflare Access (*${CLOUDFLARE_ACCESS_DOMAIN_SUFFIX})`);
  }
  return url;
}

assertEnvironment();

export async function handler(
  event: LambdaFunctionURLEvent,
): Promise<LambdaFunctionURLResult> {
  return route(event);
}
