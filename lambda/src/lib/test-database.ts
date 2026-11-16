/**
 * テスト用 DB（Neon のテスト用ブランチ）の接続先を、本番と取り違えていないか確かめる。
 *
 * local-server.ts（ローカル開発・E2E が読み書きする）と reset-test-db.ts
 * （全テーブルを TRUNCATE する）の両方が、DB に触れる前に必ず呼ぶ。
 *
 * Neon はブランチごとにエンドポイントのホスト名が違うので、
 * 「ホスト名 + DB 名」が本番と一致したら同じ DB とみなす。
 */

interface DatabaseUrls {
  /** テスト用ブランチの接続文字列（DATABASE_URL_TEST）。 */
  test: string | undefined;
  /** 本番の接続文字列（DATABASE_URL / DIRECT_URL）。比較対象として使う。 */
  production: ReadonlyArray<string | undefined>;
}

/**
 * テスト用 DB の接続文字列を返す。本番と同じ DB を指していれば例外を投げる。
 *
 * ★ 比較対象の本番 URL が1つも無いときも中止する（安全側）。
 *   比べる相手が無いまま通すと、取り違えを検出できないまま本番を消しうる。
 */
export function resolveTestDatabaseUrl(urls: DatabaseUrls): string {
  if (!urls.test) {
    throw new Error("DATABASE_URL_TEST is not set (lambda/.env を確認してください)");
  }

  const production = urls.production.filter((url): url is string => Boolean(url));
  if (production.length === 0) {
    throw new Error(
      "本番の DATABASE_URL が lambda/.env に無いため、テスト用 DB と取り違えていないか判定できません。",
    );
  }

  const testKey = toDatabaseKey(urls.test);
  if (production.some((url) => toDatabaseKey(url) === testKey)) {
    throw new Error(
      "DATABASE_URL_TEST が本番と同じ DB を指しています。Neon のテスト用ブランチの接続文字列にしてください。",
    );
  }
  return urls.test;
}

/**
 * 「ホスト名 + DB 名」。pooled と unpooled はホスト名の -pooler の有無だけが
 * 違うので、取り除いて同じ DB として扱う。
 * 例: ep-cool-123-pooler.ap-southeast-1.aws.neon.tech/neondb → ep-cool-123.ap-southeast-1.aws.neon.tech/neondb
 */
function toDatabaseKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // 接続文字列には資格情報が含まれるので、値そのものはメッセージに出さない。
    throw new Error("データベースの接続文字列の形式が正しくありません。");
  }
  const host = parsed.hostname.toLowerCase().replace("-pooler.", ".");
  return `${host}${parsed.pathname}`;
}
