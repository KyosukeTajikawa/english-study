import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

/**
 * 秘密情報を SSM Parameter Store から取得する。
 *
 * ★ なぜ環境変数に直接入れないのか ★
 *
 * CloudFormation の `{{resolve:ssm-secure:...}}` は Lambda の環境変数では
 * **使用できない**（デプロイ時に復号された平文が関数の設定欄に保存されて
 * しまうため、AWS が明示的に禁止している）。
 *
 *   Reason: SSM Secure reference is not supported in:
 *     [AWS::Lambda::Function/Properties/Environment/Variables/...]
 *
 * そこで環境変数には「値」ではなく「**パラメータ名**」だけを入れ、
 * 実際の値は Lambda 自身が実行時に取得する。秘密は SSM 内では暗号化され、
 * Lambda 内ではメモリ上にしか存在しない。
 *
 * ★ 取得回数について ★
 *
 * Lambda はコンテナを再利用するため、モジュールスコープのキャッシュが
 * 次のリクエストでも生きる。実際の SSM 呼び出しはコールドスタート時の
 * 1回だけで、以降は追加のレイテンシも API 呼び出しも発生しない。
 */

/** 取得対象の秘密情報。 */
export type SecretName = "INTERNAL_API_KEY" | "GEMINI_API_KEY";

/**
 * 秘密情報ごとの「SSM パラメータ名を格納した環境変数」の名前。
 * 値そのものではなくパラメータ名が入る点に注意（template.yaml 参照）。
 */
const PARAMETER_NAME_ENV: Record<SecretName, string> = {
  INTERNAL_API_KEY: "INTERNAL_API_KEY_PARAMETER",
  // ★ ステップ2の疎通確認専用。確認後に _gemini-smoke.ts ごと削除する。
  GEMINI_API_KEY: "GEMINI_API_KEY_PARAMETER",
};

const client = new SSMClient({});

/** コンテナが生きている間だけ保持するキャッシュ。 */
let cached: Promise<Record<SecretName, string>> | undefined;

/** 秘密情報を1つ取得する。初回のみ SSM を呼び、以降はキャッシュを返す。 */
export async function getSecret(name: SecretName): Promise<string> {
  const secrets = await loadSecrets();
  return secrets[name];
}

function loadSecrets(): Promise<Record<SecretName, string>> {
  if (cached) return cached;

  cached = fetchSecrets().catch((cause: unknown) => {
    // 失敗した Promise をキャッシュに残すと、一時的な障害が
    // コンテナの寿命いっぱい続いてしまう。破棄して次回再試行させる。
    cached = undefined;
    throw cause;
  });

  return cached;
}

async function fetchSecrets(): Promise<Record<SecretName, string>> {
  const requested = resolveParameterNames();
  const names = [...requested.keys()];

  const response = await client.send(
    new GetParametersCommand({ Names: names, WithDecryption: true }),
  );

  if (response.InvalidParameters && response.InvalidParameters.length > 0) {
    throw new Error(`SSM parameters not found: ${response.InvalidParameters.join(", ")}`);
  }

  const secrets = {} as Record<SecretName, string>;
  for (const parameter of response.Parameters ?? []) {
    const secretName = parameter.Name ? requested.get(parameter.Name) : undefined;
    if (secretName && parameter.Value) {
      secrets[secretName] = parameter.Value;
    }
  }

  const missing = [...requested.values()].filter((name) => !secrets[name]);
  if (missing.length > 0) {
    throw new Error(`SSM returned no value for: ${missing.join(", ")}`);
  }

  return secrets;
}

/** 環境変数から「SSM パラメータ名 → 秘密情報の識別子」の対応を作る。 */
function resolveParameterNames(): Map<string, SecretName> {
  const resolved = new Map<string, SecretName>();
  const missing: string[] = [];

  for (const [secretName, envName] of Object.entries(PARAMETER_NAME_ENV) as [
    SecretName,
    string,
  ][]) {
    const parameterName = process.env[envName];
    if (parameterName) {
      resolved.set(parameterName, secretName);
      continue;
    }
    missing.push(envName);
  }

  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }

  return resolved;
}
