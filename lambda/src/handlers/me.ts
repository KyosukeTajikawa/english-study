import type { LambdaFunctionURLResult } from "aws-lambda";
import type { MeData } from "@shared/types";
import { userProfileSchema } from "@shared/schemas/user";
import { getAuthenticatedUser } from "../lib/auth.js";
import { getDb } from "../lib/db.js";
import { ok } from "../lib/response.js";
import type { RequestContext } from "../router.js";

/**
 * GET /api/me — ログイン中のユーザーを返す。
 *
 * 初回アクセス時はここで User が作られる（getAuthenticatedUser の upsert）。
 */
export async function handleMe(context: RequestContext): Promise<LambdaFunctionURLResult> {
  const db = await getDb();
  const user = await getAuthenticatedUser(db, context.identity);

  // スキーマに無い列（id 等）はここで落ちる。
  const data: MeData = userProfileSchema.parse(user);
  return ok(data);
}
