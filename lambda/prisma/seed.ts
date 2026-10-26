import { createPrismaClient } from "../src/lib/db.js";

/**
 * 開発用のシード。`npm run db:seed`（prisma db seed）で実行する。
 *
 * ★ べき等にしてある。行は固定の ID で upsert するので、何度流しても増えない。
 * ★ 対話型の $transaction() を使っている。pooled + WebSocket の接続設定が
 *   正しくないとここで失敗するため、ステップ8の前提（トランザクションが動くこと）の
 *   確認も兼ねる（HTTP モードでは "Transactions are not supported" になる）。
 *
 * 接続先は pooled の DATABASE_URL（Lambda と同じ経路）。
 */

/** シードのユーザー。自分のログイン用メールにすると、画面からシードの単語が見える。 */
const SEED_USER_EMAIL = (process.env.SEED_USER_EMAIL ?? "seed@example.com").toLowerCase();

const SEED_VOCABULARIES = [
  {
    id: "seed-vocabulary-run-into",
    word: "run into",
    wordType: "idiom",
    meaning: "偶然出会う／（問題などに）ぶつかる",
    coreImage: "進んでいる途中で何かに突き当たる",
    examples: [
      { en: "I ran into an old friend at the station.", ja: "駅で旧友にばったり会った。" },
      { en: "We ran into a problem with the server.", ja: "サーバーで問題にぶつかった。" },
    ],
    source: "シード",
  },
  {
    id: "seed-vocabulary-meticulous",
    word: "meticulous",
    wordType: "word",
    meaning: "細部まで注意を払った、きわめて慎重な",
    coreImage: "一つひとつを恐れるほど丁寧に確かめる",
    examples: [{ en: "She is meticulous about her notes.", ja: "彼女はノートの取り方がとても几帳面だ。" }],
    source: null,
  },
] as const;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set (lambda/.env を確認してください)");
  }

  const db = createPrismaClient(databaseUrl);
  try {
    await db.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { email: SEED_USER_EMAIL },
        update: {},
        create: { email: SEED_USER_EMAIL },
      });

      for (const { id, ...vocabulary } of SEED_VOCABULARIES) {
        const data = { ...vocabulary, examples: [...vocabulary.examples], userId: user.id };
        await tx.vocabulary.upsert({ where: { id }, update: data, create: { id, ...data } });
      }
    });

    const count = await db.vocabulary.count({ where: { user: { email: SEED_USER_EMAIL } } });
    console.log(`seeded: user=${SEED_USER_EMAIL}, vocabularies=${count}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((cause: unknown) => {
  console.error("seed failed", cause);
  process.exitCode = 1;
});
