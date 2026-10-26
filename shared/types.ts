/**
 * フロントエンド（src/）と Lambda（lambda/src/）で共有する型。
 *
 * Prisma が生成する型をここに再輸出しないこと。DB のカラムをそのまま
 * ブラウザに晒さないよう、API の境界用の型を別に定義する。
 *
 * 入力検証を伴うものは shared/schemas/ に Zod スキーマとして置き、
 * 型は z.infer で導出する（同じ制約を二度書かない）。
 */

import type { UserProfile } from "./schemas/user";

/** すべての API レスポンスはこの形を取る。 */
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: ApiError;
}

export interface ApiError {
  /** 利用者に見せてよいメッセージ。内部情報を含めない。 */
  message: string;
  /** 入力検証に失敗したときのフィールド別エラー。 */
  fields?: Record<string, string[]>;
}

/** GET /api/health のレスポンス。疎通確認専用。 */
export interface HealthData {
  status: "ok";
  region: string;
  runtime: string;
  timestamp: string;
}

/** GET /api/me のレスポンス。ログイン中のユーザー。 */
export type MeData = UserProfile;
