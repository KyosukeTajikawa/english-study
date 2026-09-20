/**
 * フロントエンド（src/）と Lambda（lambda/src/）で共有する型。
 *
 * Prisma が生成する型をここに再輸出しないこと。DB のカラムをそのまま
 * ブラウザに晒さないよう、API の境界用の型を別に定義する。
 */

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
