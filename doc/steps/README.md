# 実装ステップ詳細

`doc/implementation-plan.md` の各ステップについて、実際にどのファイルを追加・変更するかをまとめたもの。

## 一覧

| # | ドキュメント | 内容 | 依存 |
| --- | --- | --- | --- |
| 1 | （完了） | Next.js / TypeScript / Tailwind / ESLint 導入済み | — |
| 2 | [02-smoke-test.md](./02-smoke-test.md) | Pages・Lambda・Gemini・Access の疎通確認 | 1 |
| 3 | [03-database.md](./03-database.md) | Neon、Prisma スキーマ、マイグレーション | 2 |
| 4 | [04-test-foundation.md](./04-test-foundation.md) | Vitest / Playwright、TDD 開始 | 3 |
| 5 | [05-vocabulary.md](./05-vocabulary.md) | 単語帳の登録・編集・一覧 | 3, 4 |
| 6 | [06-question-engine.md](./06-question-engine.md) | Gemini 連携と出題選択 | 5 |
| 7 | [07-study-screen.md](./07-study-screen.md) | 解答の仕組みと共通コンポーネント（学習画面は8） | 6 |
| 8 | [08-daily-review.md](./08-daily-review.md) | 毎日10問復習と途中再開 | 7 |
| 9 | [09-scheduled-jobs.md](./09-scheduled-jobs.md) | Web Push と定期実行バッチ | 8 |
| 10 | [10-quality-release.md](./10-quality-release.md) | 検証・レート制限・監視・公開 | 9 |

## 読み方

各ドキュメントは共通で以下の構成を持つ。

- **目的** — このステップで何が動くようになるか
- **前提** — 着手前に完了しているべきこと
- **追加・変更するファイル** — 具体的なパスと役割
- **実装方針** — 設計上の判断とコードの骨子
- **テスト** — 書くべきテストの種類
- **完了条件 (DoD)** — このステップを終えたと判断する基準
- **注意点** — ハマりどころ、要確認事項

## 全体像（毎回思い出すこと）

```
ブラウザ → Cloudflare Pages（静的ファイル）
              ↓ /api/* を中継
         Pages Functions
              ↓ Access の JWT を転送
         AWS Lambda（東京）── Gemini / Web Push
              ↓
         Neon (PostgreSQL)
```

**画面はブラウザで組み立てる。サーバー処理はすべて Lambda にある。** この境界を混同しないこと。

## 全ステップ共通のルール

1. **静的書き出しの制約を守る** — `next.config.ts` は `output: "export"`。Server Component でのデータ取得、Server Actions、Route Handlers は**使えない**。データ取得はすべてブラウザから Lambda の API を呼ぶ。
2. **HTTP ハンドラは必ず認証を通す** — Lambda の URL は公開されている。`X-Internal-Api-Key` の検証（`router.ts` で一括）→ `getAuthenticatedUser()` の順に必ず通す。
3. **バッチハンドラ（`cron-*.ts`）は例外** — EventBridge からのみ起動し、JWT を持たない。代わりに **Function URL を持たないこと**を `template.yaml` で担保する。DB クエリを `userId` スコープでループする点は同じ。
4. **API は `router.ts` に登録する** — Lambda Function URL はパス振り分けを持たない。`template.yaml` に「ルート」を書く場所はない。
5. **ユーザースコープ** — DB クエリは必ず `userId` スコープ経由。JWT から解決する共通ヘルパーを通し、IDをベタ書きしない。
6. **TDD** — ステップ4以降はテストを先に書く（RED → GREEN → REFACTOR）。カバレッジ 80% 以上。
7. **不変性** — 既存オブジェクトを変更せず、新しいオブジェクトを返す。
8. **入力検証** — ブラウザからの入力、Gemini のレスポンス、DB から読んだ JSON はすべて境界で Zod 検証する。
9. **シークレット** — Gemini のキーと VAPID 秘密鍵は **Lambda にしか置かない**。`NEXT_PUBLIC_` を付けてよいのは **VAPID 公開鍵のみ**。API のベース URL は相対パス（`/api`）を使い、Function URL をブラウザに埋め込まない。

## 用語

| 用語 | 意味 |
| --- | --- |
| **静的書き出し** | Next.js がビルド時に HTML/CSS/JS を出力すること。サーバーが実行時に画面を作らない |
| **Pages Functions** | Cloudflare Pages に付属する軽量なサーバー処理。ここでは Lambda への中継にのみ使う |
| **Cloudflare Access** | ログイン画面と認証を代行してくれる Cloudflare のサービス。無料枠は50ユーザー |
| **AWS SAM** | Lambda の構成をファイルで定義し、コマンドでデプロイする AWS 公式ツール |
| **EventBridge Scheduler** | AWS の定期実行サービス。cron のように Lambda を呼ぶ |
