import { fileURLToPath } from "node:url";

/**
 * ローカル開発で使う「Cloudflare Access の代役」の設定。
 * gen-test-keys.ts（JWT を作る側）と local-server.ts（検証させる側）で共有する。
 *
 * ★ 本番の値（samconfig.toml）とは決して一致させないこと。発行者も aud も
 *   ローカル専用の値にしておけば、テスト鍵で作った JWT は本番では必ず拒否される。
 */

/** 発行者のホスト名。.invalid は実在しないことが保証されたドメイン（RFC 6761）。 */
export const LOCAL_TEAM_DOMAIN = "local-access.invalid";

export const LOCAL_AUDIENCE = "english-study-app-local";

export const LOCAL_KEY_ID = "local-test-key";

/** local-server.ts が公開鍵を配信するパス。/api/* と重ならないようにする。 */
export const LOCAL_JWKS_PATH = "/__local/jwks.json";

/** テスト鍵の置き場所（lambda/.local-keys/）。秘密鍵を含むため .gitignore 済み。 */
const KEY_DIR = fileURLToPath(new URL("../.local-keys/", import.meta.url));
export const LOCAL_KEY_PATHS = {
  dir: KEY_DIR,
  privateKey: `${KEY_DIR}private-key.json`,
  jwks: `${KEY_DIR}jwks.json`,
} as const;

/** lambda/.env の絶対パス。 */
export const LAMBDA_ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));
