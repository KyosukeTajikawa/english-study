import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Pages Functions ↔ Lambda 間の共有シークレットを検証する。
 *
 * Function URL は AuthType: NONE で公開されており、Cloudflare を経由せず
 * 誰でも直接叩ける。JWT 検証だけに頼ると、JWT が漏れた場合に Cloudflare 側の
 * ポリシーも WAF も効かないバイパス経路になる。そのため JWT より前に
 * この検証を通し、失敗したら DB にも Gemini にも触れずに終了する。
 */

const HEADER_NAME = "x-internal-api-key";

/**
 * ヘッダの共有シークレットが期待値と一致するか。
 *
 * 比較は定数時間で行う。timingSafeEqual は長さが違うと例外を投げるため、
 * 双方を SHA-256 で固定長にしてから比較する。これにより長さの違いも
 * 一定時間で失敗する（長さがタイミングから漏れない）。
 */
export function isValidInternalKey(
  headers: Record<string, string | undefined>,
  expected: string | undefined,
): boolean {
  if (!expected) {
    // 設定漏れ。「期待値が空なら素通し」にすると設定ミスが認証の穴になる。
    return false;
  }

  const provided = findHeader(headers, HEADER_NAME);
  if (provided === undefined) {
    return false;
  }

  return timingSafeEqual(sha256(provided), sha256(expected));
}

/**
 * ヘッダ名の大文字小文字を無視して取得する。
 * Lambda Function URL はヘッダ名を小文字化して渡すが、
 * ローカルの HTTP サーバー経由では揺れうるため正規化する。
 */
function findHeader(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
