import type { PrismaClient } from "../lib/db.js";

/**
 * User のデータアクセス。
 *
 * リポジトリ関数は第1引数に db、第2引数に userId を取る（CLAUDE.md の必須ルール 4）。
 * 例外は upsertUserByEmail のみ。認証の時点ではまだ userId が無く、
 * JWT で検証済みの email からそれを解決するための関数だから。
 */

/** API の境界で返すユーザー情報。DB の行をそのまま外に出さない。 */
export interface UserRecord {
  id: string;
  email: string;
  timezone: string;
  notificationTime: string;
}

const USER_SELECT = {
  id: true,
  email: true,
  timezone: true,
  notificationTime: true,
} as const;

/**
 * email で User を取得し、無ければ作る。何度呼んでも1行にしかならない。
 *
 * ★ 呼び出し元は JWT の署名・aud・iss を検証済みであること（lib/auth.ts）。
 *   未検証の email を渡すと、任意のユーザーを名乗れてしまう。
 */
export function upsertUserByEmail(db: PrismaClient, email: string): Promise<UserRecord> {
  return db.user.upsert({
    where: { email },
    // 既存ユーザーの設定は上書きしない。
    update: {},
    create: { email },
    select: USER_SELECT,
  });
}
