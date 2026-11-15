import { neonConfig } from "@neondatabase/serverless";
import { PrismaNeon } from "@prisma/adapter-neon";
import ws from "ws";
import { PrismaClient } from "../generated/prisma/client.js";
import { getSecret } from "./secrets.js";

/**
 * Prisma Client の生成。
 *
 * ★ 接続方式は pooled + WebSocket（PrismaNeon）。
 *   HTTP モード（PrismaNeonHttp）はトランザクションを一切サポートしない。
 *   ステップ8で DailySet の作成と lastServedAt の更新を同一トランザクションで
 *   行うため使えない（doc/steps/03-database.md の 1-2）。
 *   Lambda の同時実行数ぶんの接続は、pooled エンドポイントの PgBouncer が吸収する。
 */

// Neon のドライバは WebSocket の実装を外から受け取る。
// 未設定だと Node ではグローバルの WebSocket に頼ることになり、
// ランタイムのバージョン次第で接続できなくなる。明示的に ws を使う。
neonConfig.webSocketConstructor = ws;

/** 接続文字列から Prisma Client を作る。シード等の CLI からも使う。 */
export function createPrismaClient(connectionString: string): PrismaClient {
  const adapter = new PrismaNeon({ connectionString });
  return new PrismaClient({ adapter });
}

/**
 * コンテナが生きている間だけ使い回すクライアント。
 *
 * Lambda はコンテナを再利用するため、1回だけ生成すれば以降のリクエストでも
 * 接続を使い回せる。接続文字列は SSM から取得するので非同期になる
 * （平文を環境変数に置けない理由は secrets.ts 参照）。
 */
let cached: Promise<PrismaClient> | undefined;

export function getDb(): Promise<PrismaClient> {
  if (cached) return cached;

  cached = getSecret("DATABASE_URL")
    .then(createPrismaClient)
    .catch((cause: unknown) => {
      // 失敗した Promise を残すと、一時的な障害がコンテナの寿命いっぱい続く。
      cached = undefined;
      throw cause;
    });

  return cached;
}

export type { PrismaClient };
