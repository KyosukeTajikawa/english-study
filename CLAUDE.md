# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ Next.js バージョンに関する注意

このプロジェクトは **Next.js 16.3.4** を使用しています。これはアシスタントの学習データのカットオフより後にリリースされたバージョンのため、規約・API・ファイル構成が想定と異なる可能性があります。App Router／ルーティング／データフェッチ関連のコードを書く前に、`node_modules/next/dist/docs/` 以下の該当ガイド（サブディレクトリ: `01-app`, `02-pages`, `03-architecture`）を読んでください。`src/app/layout.tsx` で使われている `LayoutProps<"/">` は typed-routes 用に生成されるヘルパー型であり、通常の React の props 型ではありません。単純な `{ children: React.ReactNode }` に「修正」しないでください。

リポジトリ直下の `AGENTS.md` は `next dev` 実行のたびに自動生成・再追加されます（`node_modules/next/dist/server/lib/generate-agent-files.js` を参照）。`git diff` でこのファイルの変更が出るのは想定内なので、元に戻すのではなく他の変更と一緒にコミットしてください。

## プロジェクトの現状

このリポジトリは `create-next-app` で生成したままの状態で、アプリケーションのコードはまだ書かれていません（`src/app/page.tsx` はデフォルトのスターターページのまま）。

仕様の正は `doc/implementation-plan.md`、各ステップの実装詳細は `doc/steps/` にあります（いずれも日本語）。**実装前に必ず該当ステップのドキュメントを読んでください。**

### ⚠️ アーキテクチャの最重要ポイント

**このプロジェクトは Next.js を静的書き出し（`output: "export"`）で使い、サーバー処理はすべて AWS Lambda に置きます。**

```
ブラウザ → Cloudflare Pages（静的ファイル配信のみ）
             ↓ /api/* を Pages Functions が中継
        AWS Lambda 東京リージョン（Prisma / Gemini / Web Push）
             ↓
        Neon (PostgreSQL)
```

このため、**Next.js の一般的な作法がいくつも使えません。**

| 項目 | 扱い |
| --- | --- |
| **Server Actions** | 静的書き出しで**非対応**。使えない |
| **リクエスト時のデータ取得** | 非対応。ブラウザから Lambda の API を呼ぶ |
| **Route Handlers（`src/app/api/`）** | このプロジェクトでは**使わない**。API は Lambda 側（`lambda/src/handlers/`）に置く |
| **動的ルート `/foo/[id]`** | `generateStaticParams` が必須で ID を事前に列挙できない。クエリパラメータ（`?id=xxx`）を使う |
| **`useSearchParams`** | `<Suspense>` で囲まないと**本番ビルドが失敗する**（dev では動くので気づけない） |
| `next.config` の `redirects` / `rewrites` / `headers` | 非対応。ヘッダは `public/_headers` を使う |
| Proxy（旧 middleware）、`cookies()`、ISR、Draft Mode | 非対応 |
| 画像最適化 | `images: { unoptimized: true }` が必要 |
| `NEXT_PUBLIC_*` | **ビルド時に静的展開される。** Pages の Git 連携でビルドさせること |

> **正確な理解**: Server Components 自体はビルド時に実行されるので「使えない」わけではない。非対応なのは**リクエスト時**の動的処理。ただし本プロジェクトは**設計判断として**データ取得を全て Lambda に寄せ、画面はクライアントコンポーネントで構成する。フレームワークの制約ではなく方針なので、勝手に変えないこと。

「Server Action にすれば簡単では」と思っても**採用しないでください。** ビルドが通りません。

### なぜこの構成なのか（変更しないこと）

- **Cloudflare Workers 無料枠は CPU 10ms/リクエスト。** Next.js の SSR は単体で 10〜20ms 消費するため成立しない。だから静的配信にしている
- **Gemini API は呼び出し元 IP のリージョンで制限される。** Cloudflare のエッジからは弾かれる可能性があるため、東京リージョンの Lambda から呼ぶ
- **Lambda は素の Node.js。** `web-push` がそのまま動く（Workers では動かない可能性があった）
- **認証は Cloudflare Access。** 認証コードを自前で書かない

### 実装時の必須ルール

1. **HTTP ハンドラは認証を2段で通す。** `router.ts` での `X-Internal-Api-Key` 検証 → `getAuthenticatedUser()`（JWT）の順。Function URL は公開されているので省略不可
2. **バッチハンドラ（`cron-*.ts`）は例外。** EventBridge からのみ起動し JWT を持たない。代わりに **Function URL を持たないこと**で守る。`getAuthenticatedUser()` を入れようとしないこと
3. **API は `router.ts` に登録する。** Lambda Function URL はパス振り分けを持たない。`template.yaml` にルートを書く場所はない
4. **DB クエリは必ず `userId` スコープを通す。** リポジトリ関数は第1引数に `db`、第2引数に `userId` を取る（`getVocabulary(db, userId, id)`）。ID だけで引く関数を作らない
5. **`Question` だけ `userId` を持たない。** `Vocabulary` 経由で紐づくので、取得時は `vocabulary: { userId }` を経由する
6. **クライアントから受け取る ID は必ず所有者を確認する。** `questionId` も `dailySetId` も同じ
7. **出題 API のレスポンスに `answer` と `explanation` を含めない。** ブラウザに渡ると答えが見える
8. **Gemini のキーと VAPID 秘密鍵は Lambda にのみ置く。** `NEXT_PUBLIC_` を付けてよいのは **VAPID 公開鍵のみ**。API は常に相対パス `/api` を叩き、Function URL をフロントに埋め込まない
9. **`Vocabulary` は論理削除**（`deletedAt`）。物理削除すると学習履歴が失われる

### 未確定事項（勝手に決めず、実装前にユーザーに確認する）

- Gemini の無料枠（モデルごとの1日あたり上限）— ステップ2で実測する
- 出題形式（`Question.format`）の具体的な一覧 — ステップ6の着手前に確定する

### 決定済み（再検討しないこと）

- **自由学習画面（`/study`）は作らない。** 復習（`/review`）に一本化
- **DB 接続は Neon の pooled + WebSocket。** HTTP ドライバはトランザクション非対応のため使わない
- **AWS Lambda の無料枠は恒久**（100万リクエスト/月、40万GB秒）

## コマンド

現時点で存在するもの:

```bash
npm run dev     # 開発サーバー起動（next dev、Turbopack 使用）
npm run build   # 本番ビルド
npm run start   # 本番ビルドの起動
npm run lint    # ESLint（flat config、eslint.config.mjs）
```

テストランナーは未設定です — `package.json` にテストスクリプトはなく、テストファイルもリポジトリ内に存在しません（ステップ4で Vitest / Playwright を導入予定）。

`lambda/` ディレクトリはまだ存在しません（ステップ2で作成）。作成後は Lambda 側で別途 `npm install` が必要になります。

## バージョン固定の注意

以下は npm の `latest` をそのまま入れると壊れます。

| パッケージ | 指定 | 理由 |
| --- | --- | --- |
| `prisma` | `7.10.0` を明示 | `latest` が `8.0.0-rc`（リリース候補）を指しており、`@prisma/client@7.10.0` と不整合になる |
| `vitest` | `4.1.11` | `5.0.0` は周辺エコシステムが未追従 |
| `@vitest/coverage-v8` | `4.1.11` を明示 | peer が `vitest` と**完全一致**を要求。`latest`（5.x）を入れると必ず衝突する |
| `@vitejs/plugin-react` | バージョン固定 | 最新は `vite ^8` を要求し、vitest 4 系と解決不能になりうる |
| `@google/genai` | これを使う | 旧 SDK の `@google/generative-ai` は非推奨 |

**Node.js は 22.12 以上**を使ってください。Next.js 16 の要件は `>=20.9.0` ですが、`@vitejs/plugin-react` の `engines` が `^20.19.0 || >=22.12.0` のため 20.9.0 では足りません。

Lambda のランタイムは **`nodejs22.x` 以上**。`nodejs20.x` は 2026-04-30 に廃止済みです。

## アーキテクチャ

- App Router は `src/app/` 以下にあり、`@/*` パスエイリアスは `src/*` にマッピングされています（`tsconfig.json` 参照）。**ただし静的書き出しのため、サーバー側の機能は使えません**（上記参照）。
- スタイリングは Tailwind CSS v4 を `@tailwindcss/postcss` 経由で使用しており（`postcss.config.mjs` 参照）、グローバルスタイルは `src/app/globals.css` にあります。`tailwind.config.*` は存在しません — v4 は JS の設定ファイルではなく CSS/PostCSS 側で設定します。
- ESLint は flat config 形式（`eslint.config.mjs`）で、`eslint-config-next` の `core-web-vitals` と `typescript` ルールセットを継承しています。
- TypeScript は strict モードです（`tsconfig.json` の `strict: true`）。
