import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // ルートの Next.js 設定で評価してはいけない領域。
    // それぞれ専用の設定と typecheck を持つ（doc/steps/02-smoke-test.md）。
    "lambda/**",
    "functions/**",
    "e2e/**",
  ]),
]);

export default eslintConfig;
