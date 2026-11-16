import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

/**
 * UI 開発（next dev）で /api/* を転送する先。`wrangler pages dev` の中継。
 *
 * ★ local-server（:3001）へ直接送らないこと。ブラウザは X-Internal-Api-Key も
 *   JWT も付けないので必ず 403 になる。中継を通せば、本番と同じく中継が
 *   それらを付けて local-server へ転送する（doc/steps/04-test-foundation.md の 8-2）。
 */
const DEV_API_RELAY = "http://127.0.0.1:8788";

const baseConfig: NextConfig = {
  // Cloudflare Pages へ静的ファイルとして配信する。
  // サーバー処理は AWS Lambda 側にあるため、SSR は使わない。
  // 詳細は doc/steps/02-smoke-test.md を参照。
  output: "export",

  // 静的書き出しでは既定の画像最適化ローダーが使えない。
  images: {
    unoptimized: true,
  },
};

export default function nextConfig(phase: string): NextConfig {
  // rewrites は静的書き出しに含まれない（本番では Pages Functions が /api/* を受ける）。
  // dev サーバーでだけ付け、ビルドには一切渡さない。
  if (phase !== PHASE_DEVELOPMENT_SERVER) {
    return baseConfig;
  }

  return {
    ...baseConfig,
    async rewrites() {
      return [{ source: "/api/:path*", destination: `${DEV_API_RELAY}/api/:path*` }];
    },
  };
}
