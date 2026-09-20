import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cloudflare Pages へ静的ファイルとして配信する。
  // サーバー処理は AWS Lambda 側にあるため、SSR は使わない。
  // 詳細は doc/steps/02-smoke-test.md を参照。
  output: "export",

  // 静的書き出しでは既定の画像最適化ローダーが使えない。
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
