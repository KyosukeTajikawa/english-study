import { defineConfig, devices } from "@playwright/test";

/**
 * E2E の設定。`npm run test:e2e` で実行する（先にテスト用 DB をリセットする）。
 *
 * 本番と同じ経路で動かす:
 *   ブラウザ → wrangler pages dev（out/ + Pages Functions の中継）→ local-server（router.ts）
 *
 * ★ next dev では Pages Functions が動かず、中継経路を確かめられない。
 *   また、ビルドを挟まないと古い out/ でテストが走り、原因不明の失敗になる
 *   （doc/steps/04-test-foundation.md の 9）。
 */

const PAGES_PORT = 8788;
const LOCAL_SERVER_PORT = 3001;
const BASE_URL = `http://127.0.0.1:${PAGES_PORT}`;

/**
 * Workers ランタイムの互換日付。未指定だと wrangler が警告を出し、
 * wrangler を更新するたびに既定値が変わって挙動がずれうるので固定する。
 * package.json の preview スクリプトと同じ値にすること。
 */
const COMPATIBILITY_DATE = "2026-09-07";

/** ビルドと wrangler の起動を待つ上限。初回の next build は時間がかかる。 */
const WEB_SERVER_TIMEOUT_MS = 180_000;

export default defineConfig({
  testDir: "./e2e",
  // テスト用 DB を共有するので、日付依存のテスト（ステップ8）が干渉しないよう直列に流す。
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm --prefix lambda run local",
      // 公開鍵の配信パスは認証なしで 200 を返すので、起動の確認に使える。
      url: `http://127.0.0.1:${LOCAL_SERVER_PORT}/__local/jwks.json`,
      reuseExistingServer: !process.env.CI,
      timeout: WEB_SERVER_TIMEOUT_MS,
    },
    {
      command: `npm run build && npx wrangler pages dev out/ --ip 127.0.0.1 --port ${PAGES_PORT} --compatibility-date=${COMPATIBILITY_DATE}`,
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: WEB_SERVER_TIMEOUT_MS,
    },
  ],
});
