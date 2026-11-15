import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

/**
 * Prisma CLI（migrate / generate / seed）の設定。Prisma 7 で必須。
 *
 * ★ これは CLI 専用で、Lambda のバンドルには含まれない。
 *   Lambda は実行時に SSM から接続文字列を取得する（src/lib/db.ts）。
 *
 * Prisma 7 は .env を自動で読まないため、ここで読み込む。
 * ファイルが無い環境（CI の prisma generate 等）でも落ちないようにしている。
 */
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // ★ マイグレーションは unpooled（直結）の DIRECT_URL で行う。
    //   pooled（PgBouncer のトランザクションモード）経由では、migrate が使う
    //   advisory lock がセッションをまたいで保持できず失敗しうる。
    //   アプリ本体（Lambda・シード）は pooled の DATABASE_URL を使う。
    //
    //   env() ではなく process.env を使うのは、prisma generate のように
    //   DB 接続が要らないコマンドを、URL 未設定の環境でも実行できるようにするため
    //   （env() は未設定だと例外を投げる）。
    url: process.env.DIRECT_URL,
  },
});
