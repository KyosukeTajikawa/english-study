import { defineConfig } from "vitest/config";

/**
 * Lambda 側の Vitest 設定（node 環境）。
 *
 * ロジックの大半（出題選択・日付計算・JWT 検証・リポジトリ）はこちらにあるため、
 * カバレッジの重心もここに置く（doc/steps/04-test-foundation.md の 1）。
 */

/** これを下回ったらテストを失敗させる。 */
const COVERAGE_THRESHOLD_PERCENT = 80;

export default defineConfig({
  resolve: {
    // tsconfig.json の paths（@shared/* → ../shared/*）をそのまま使う。
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // テスト間で環境変数の変更が漏れないようにする（auth.test.ts が書き換える）。
    unstubEnvs: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/__tests__/**",
        "src/generated/**",
        // DB 接続の生成のみ。ロジックを持たない。
        "src/lib/db.ts",
        // ローカル開発専用。本番のバンドルに入らない。
        "src/local-server.ts",
        // 疎通確認用。
        "src/handlers/health.ts",
      ],
      thresholds: {
        lines: COVERAGE_THRESHOLD_PERCENT,
        functions: COVERAGE_THRESHOLD_PERCENT,
        branches: COVERAGE_THRESHOLD_PERCENT,
        statements: COVERAGE_THRESHOLD_PERCENT,
      },
    },
  },
});
