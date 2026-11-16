import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * フロント用の Vitest 設定（jsdom 環境）。
 *
 * 対象は React コンポーネントと API クライアント。画面はすべてクライアント
 * コンポーネントなので、fetch をモックすれば単体でテストできる。
 * Lambda 側は別設定（lambda/vitest.config.ts）で、こちらからは実行しない。
 */

/** これを下回ったらテストを失敗させる。 */
const COVERAGE_THRESHOLD_PERCENT = 80;

export default defineConfig({
  plugins: [react()],
  resolve: {
    // tsconfig.json の paths（@/* と @shared/*）をそのまま使う。
    tsconfigPaths: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "shared/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "shared/**/*.ts"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "shared/**/*.test.ts",
        // 型定義のみ。カバレッジを水増ししない。
        "shared/types.ts",
        // create-next-app のスターター。ステップ5で置き換えるときにこの2行を外す。
        "src/app/page.tsx",
        "src/app/layout.tsx",
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
