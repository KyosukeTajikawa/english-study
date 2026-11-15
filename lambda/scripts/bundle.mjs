import { build } from "esbuild";

/**
 * Lambda 用のバンドルを dist/ に作る。`npm run bundle` から呼ばれる。
 *
 * ★ SAM の esbuild ビルダー（BuildMethod: esbuild）を使わない理由:
 *   - SAM はソースを一時ディレクトリへコピーしてからビルドするため、
 *     lambda/ の外にある ../shared/ が解決できない
 *   - 回避策の build_in_source は、ソースの node_modules に対して本番用の
 *     npm install を実行し、開発用の依存（esbuild・eslint・tsx）を削除してしまう
 *   SAM には Makefile 経由でこの成果物をコピーさせるだけにしている。
 */
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  // ★ ESM ではなく CommonJS でバンドルする。
  // npm の実用的なパッケージの多くは今も CommonJS で書かれており、内部で
  // require() を呼ぶ。ESM 形式にバンドルすると require が存在せず、読み込んだ
  // 瞬間に落ちる（Dynamic require of "node:https" is not supported）。
  // package.json が "type": "module" なので拡張子は .cjs にする。
  format: "cjs",
  minify: true,
  // NODE_OPTIONS=--enable-source-maps（template.yaml）でスタックトレースを元の行に戻す。
  // ソース本文は埋め込まない（行の対応には不要で、成果物が数MB増えるだけ）。
  sourcemap: true,
  sourcesContent: false,
  external: [
    // ★ AWS SDK はランタイム同梱のものを使う（バンドルしない）。
    "@aws-sdk/*",
    "@smithy/*",
    // ws の任意の高速化モジュール。ws は require を try/catch で囲んでおり、
    // 無ければ JS 実装で動く。バンドルに含めず、解決エラーだけを避ける。
    "bufferutil",
    "utf-8-validate",
  ],
  logLevel: "warning",
});
