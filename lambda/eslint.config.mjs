import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

/**
 * Lambda 側の ESLint 設定。
 *
 * ルート（eslint.config.mjs）は Next.js / ブラウザ前提の設定なので使わない。
 * これが無いと ESLint が親ディレクトリを遡ってルート設定を読み、Lambda の
 * コードに @next/ のルールが適用されてしまう（doc/steps/02-smoke-test.md）。
 */
export default defineConfig([
  globalIgnores([".aws-sam/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // 未定義識別子の検出は TypeScript が行う。no-undef を有効にすると
      // Node のグローバル（process, console, Buffer …）を二重に宣言する
      // 必要が生じるだけで、得るものがない。
      "no-undef": "off",
    },
  },
]);
