import { existsSync } from "node:fs";
import { createPrismaClient } from "../src/lib/db.js";
import { resolveTestDatabaseUrl } from "../src/lib/test-database.js";
import { seedDatabase } from "./seed.js";

/**
 * テスト用 DB を空にしてシードし直す。`npm run db:reset-test` で実行する。
 * E2E の前に必ず流す（package.json の test:e2e が呼ぶ）。
 *
 * 前日の DailySet などが残っていると、ステップ8の「同日に同じセットが返る」の
 * ような日付依存のテストが結果を変えてしまう（doc/steps/04-test-foundation.md の 8）。
 *
 * ★ 本番の DB を消さないための安全装置:
 *   1. 接続先は DATABASE_URL_TEST だけ。DATABASE_URL にフォールバックしない
 *   2. DATABASE_URL / DIRECT_URL と同じ DB なら中止する（src/lib/test-database.ts）
 */

/** 全テーブル。親子関係があるので CASCADE で一度に空にする。 */
const TABLES = [
  "User",
  "Vocabulary",
  "Question",
  "Attempt",
  "DailySet",
  "PushSubscription",
  "RateLimit",
] as const;

async function main(): Promise<void> {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }

  const testUrl = resolveTestDatabaseUrl({
    test: process.env.DATABASE_URL_TEST,
    production: [process.env.DATABASE_URL, process.env.DIRECT_URL],
  });

  const db = createPrismaClient(testUrl);
  try {
    const tableList = TABLES.map((table) => `"${table}"`).join(", ");
    // テーブル名は上の固定値のみ。外部の入力は混ざらない。
    await db.$executeRawUnsafe(`TRUNCATE TABLE ${tableList} CASCADE`);
    console.log(`reset: ${TABLES.length} tables truncated`);

    // シードは seed.ts の import 時点の環境変数を見るため、ここで読んだ値を明示的に渡す。
    await seedDatabase(db, (process.env.SEED_USER_EMAIL ?? "seed@example.com").toLowerCase());
  } finally {
    await db.$disconnect();
  }
}

main().catch((cause: unknown) => {
  console.error("reset-test-db failed", cause instanceof Error ? cause.message : cause);
  process.exitCode = 1;
});
