import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { exportJWK, generateKeyPair, importJWK, SignJWT, type CryptoKey, type JWK } from "jose";
import {
  LAMBDA_ENV_PATH,
  LOCAL_AUDIENCE,
  LOCAL_KEY_ID,
  LOCAL_KEY_PATHS,
  LOCAL_TEAM_DOMAIN,
} from "./local-access.js";

/**
 * ローカル検証用のテスト鍵ペアと JWT を作る。`npm run keys:generate` で実行する。
 *
 * 出力した JWT を .dev.vars の LOCAL_TEST_JWT に貼ると、`wrangler pages dev` の
 * 中継がそれを Lambda（local-server.ts）へ転送し、本番と同じロジックで検証される。
 *
 * ★ JWT の署名はこの手元スクリプトだけで行う。中継（functions/api/[[path]].ts）に
 *   署名処理を入れると、設定ミス1つで「任意のユーザーを名乗れる中継」になる
 *   （doc/steps/04-test-foundation.md の 7）。
 *
 * オプション:
 *   --email <addr>  JWT に入れるメールアドレス（既定: SEED_USER_EMAIL か local@example.com）
 *   --untrusted     信頼されていない鍵で署名する。401 になることの確認用
 *   --rotate        既存の鍵を捨てて作り直す（以前の JWT は通らなくなる）
 */

const ALGORITHM = "RS256";

/** ローカル専用の鍵でしか通らないので、毎日作り直さずに済む長さにする。 */
const TOKEN_LIFETIME = "365d";

const DEFAULT_EMAIL = "local@example.com";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      untrusted: { type: "boolean", default: false },
      rotate: { type: "boolean", default: false },
    },
  });

  const email = (values.email ?? readSeedEmail() ?? DEFAULT_EMAIL).toLowerCase();
  const signingKey = values.untrusted
    ? (await generateKeyPair(ALGORITHM)).privateKey
    : await loadOrCreateTrustedKey(values.rotate);

  const token = await new SignJWT({ email })
    .setProtectedHeader({ alg: ALGORITHM, kid: LOCAL_KEY_ID })
    .setIssuer(`https://${LOCAL_TEAM_DOMAIN}`)
    .setAudience(LOCAL_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(TOKEN_LIFETIME)
    .sign(signingKey);

  const label = values.untrusted ? "信頼されていない鍵で署名（401 になるはず）" : "テスト鍵で署名";
  console.error(`# ${label}: email=${email}, 有効期限=${TOKEN_LIFETIME}`);
  console.error("# 次の1行を .dev.vars に貼ってください:");
  console.log(`LOCAL_TEST_JWT=${token}`);
}

/** lambda/.env の SEED_USER_EMAIL。シードのデータが画面で見えるように揃える。 */
function readSeedEmail(): string | undefined {
  if (existsSync(LAMBDA_ENV_PATH)) {
    process.loadEnvFile(LAMBDA_ENV_PATH);
  }
  return process.env.SEED_USER_EMAIL || undefined;
}

/**
 * 既存の鍵があれば使い回す。作り直すと、.dev.vars に貼った JWT が通らなくなるため。
 */
async function loadOrCreateTrustedKey(rotate: boolean): Promise<CryptoKey> {
  if (!rotate && existsSync(LOCAL_KEY_PATHS.privateKey)) {
    const privateJwk = JSON.parse(readFileSync(LOCAL_KEY_PATHS.privateKey, "utf8")) as JWK;
    return (await importJWK(privateJwk, ALGORITHM)) as CryptoKey;
  }

  const { publicKey, privateKey } = await generateKeyPair(ALGORITHM, { extractable: true });
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: LOCAL_KEY_ID, alg: ALGORITHM };

  mkdirSync(LOCAL_KEY_PATHS.dir, { recursive: true, mode: 0o700 });
  // 秘密鍵は所有者だけが読めるようにする。
  writeFileSync(LOCAL_KEY_PATHS.privateKey, JSON.stringify(await exportJWK(privateKey)), {
    mode: 0o600,
  });
  writeFileSync(LOCAL_KEY_PATHS.jwks, JSON.stringify({ keys: [publicJwk] }, null, 2));
  console.error(`# 新しいテスト鍵を作りました: ${LOCAL_KEY_PATHS.dir}`);

  return privateKey;
}

main().catch((cause: unknown) => {
  console.error("failed to generate test keys", cause);
  process.exitCode = 1;
});
