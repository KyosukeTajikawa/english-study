import { z } from "zod";

/**
 * GET /api/me が返すユーザー情報。
 *
 * Lambda はレスポンスをこのスキーマで parse してから返す。z.object は
 * 定義に無いキーを落とすので、DB の行に列が増えてもブラウザには漏れない
 * （Prisma の型をそのまま公開しない、という shared/types.ts の方針を実行時にも守る）。
 */
export const userProfileSchema = z.object({
  email: z.email(),
  /** IANA タイムゾーン名（例: Asia/Tokyo） */
  timezone: z.string(),
  /** 通知時刻（HH:mm） */
  notificationTime: z.string(),
});

export type UserProfile = z.infer<typeof userProfileSchema>;
