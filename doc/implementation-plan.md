# 英語学習アプリ 実装プラン

## 1. 目的

ユーザーが登録した英単語・イディオム・コアイメージを基に学習問題を作成し、Gemini API を使って問題の重複を抑える。毎日ランダムな 10 問を復習でき、Web Push 通知で学習を促す。

**すべて無料枠の範囲内で、インターネットに公開して運用する。**

## 2. 全体構成

```
                  ブラウザ
                     │
                     │ ① Cloudflare Access でログイン
                     ▼
        ┌────────────────────────────┐
        │  Cloudflare Pages          │  静的ファイルの配信のみ
        │  （Next.js の静的書き出し）  │  サーバー処理をしない = CPU を使わない
        └────────────────────────────┘
                     │
                     │ ② /api/* へのリクエストを中継
                     ▼
        ┌────────────────────────────┐
        │  Pages Functions（薄い中継）│  転送するだけ。CPU 消費はごく小さい
        └────────────────────────────┘
                     │
                     │ ③ Access の JWT を付けて転送
                     ▼
        ┌────────────────────────────┐
        │  AWS Lambda（東京リージョン）│  ★ 実際の処理はすべてここ
        │  Prisma / Gemini / Web Push │
        └────────────────────────────┘
                     │
                     ▼
              Neon (PostgreSQL)
```

定期実行は AWS 側で完結する。

```
EventBridge Scheduler ──▶ Lambda（通知バッチ / 問題生成バッチ）
```

### なぜこの構成なのか

| 制約 | 対応 |
| --- | --- |
| Cloudflare Workers 無料枠は **CPU 10ms/リクエスト** | サーバーレンダリングをやめ、Pages は静的ファイルを配るだけにする。CPU をほぼ使わない |
| Gemini API は**呼び出し元 IP のリージョン**で制限される | Gemini を呼ぶのは東京リージョンの Lambda。日本の IP から発信される |
| Lambda は素の Node.js | `web-push` がそのまま動く。Workers ランタイムの互換性問題が消える |
| 公開するので認証が要る | Cloudflare Access（50ユーザーまで永年無料）。**認証コードを自分で書かない** |

### 費用

| サービス | 無料枠 | 想定使用量 | 超過時 |
| --- | --- | --- | --- |
| Cloudflare Pages（静的配信） | **無制限**（Functions を起動しないリクエスト） | — | — |
| Cloudflare Pages Functions | 10万回/日（UTC 0時リセット）、ビルド500回/月 | 数百回/日 | — |
| Cloudflare Access | 50ユーザー、永年無料 | 1ユーザー | $7/ユーザー/月 |
| AWS Lambda | 月100万リクエスト、40万GB秒（**恒久**） | 月1000リクエスト未満 | 従量課金 |
| EventBridge Scheduler | 月1,400万回 | 月約750回 | $1/百万回 |
| Neon (PostgreSQL) | 0.5GB、100 CU時間/月、10ブランチ | 数MB | 従量課金（月額最低なし） |
| Google Gemini | Flash 系にあり（上限は要確認） | 1日10リクエスト程度 | Flash-Lite で月$0.3程度 |

**想定される運用コストは $0。**

> ⚠️ **新規 AWS アカウントの注意**: 2025-07-15 以降に作成したアカウントは「Free Plan」に入り、**開設から6ヶ月経過またはクレジット枯渇で自動クローズ**される。恒久運用するには Paid Plan への切り替えが必要（切り替え後は always-free 枠が有効）。

## 3. 技術構成

| 領域 | 採用技術 |
| --- | --- |
| フロントエンド | Next.js 16.3.4（App Router、**静的書き出し**）+ React 19 + TypeScript |
| スタイリング | Tailwind CSS v4 |
| 配信 | Cloudflare Pages |
| API | AWS Lambda（Node.js、TypeScript、AWS SAM で管理） |
| データベース | Neon (PostgreSQL) + Prisma（`PrismaNeon` = **pooled 接続 + WebSocket**） |
| AI | Google Gemini API（`@google/genai`、Lambda から呼ぶ） |
| 認証 | Cloudflare Access（Zero Trust） |
| 通知 | Web Push（`web-push`、Lambda から送信） |
| 定期実行 | Amazon EventBridge Scheduler |
| テスト | Vitest（単体・結合）+ Playwright（E2E） |

### バージョンの注意

| パッケージ | 制約 |
| --- | --- |
| `prisma` | npm の `latest` は **`8.0.0-rc`**。`@prisma/client@7.10.0` と揃えるため **`7.10.0` を明示**する |
| `vitest` | `4.1.11` に固定 |
| `@vitest/coverage-v8` | **`4.1.11` を明示**。peer が `vitest` と完全一致を要求するため、`latest`（5.x）は必ず衝突する |
| `@vitejs/plugin-react` | バージョンを固定する。最新は `vite ^8` を要求し vitest 4 系と解決不能になりうる |
| `@google/genai` | `2.21.0`。旧 SDK の `@google/generative-ai` ではない |
| Node.js | **22.12 以上**。Next 16 の要件は `>=20.9.0` だが `@vitejs/plugin-react` の `engines` が `^20.19.0 \|\| >=22.12.0` |
| Lambda ランタイム | **`nodejs22.x` 以上**。`nodejs20.x` は 2026-04-30 に廃止済み |

### ★ Neon の接続方式（重要な設計判断）

**`@prisma/adapter-neon` の HTTP モードはトランザクションを一切サポートしない。** 実装コードが `startTransaction()` で明示的に例外を投げる:

```js
async startTransaction() {
  return Promise.reject(new Error("Transactions are not supported in HTTP mode"));
}
```

対話型・配列形式のどちらの `$transaction()` も失敗する。

| export | 実体 | トランザクション |
| --- | --- | --- |
| `PrismaNeon` | `neon.Pool`（**WebSocket**） | **可** |
| `PrismaNeonHttp` | `neon()`（HTTP） | 不可 |

本プロジェクトは `DailySet` 作成と `lastServedAt` 更新を同一トランザクションで行う必要があるため、**`PrismaNeon`（pooled 接続 + WebSocket）を使う。**

当初 HTTP を検討した理由は「TCP 接続だと Lambda の同時実行数だけコネクションが張られ Neon の上限に当たる」だったが、**Neon の pooled エンドポイント（`...-pooler.<region>.aws.neon.tech`）が PgBouncer で吸収する**ため、この懸念は接続文字列の選択で解消する。

Node 環境には グローバル `WebSocket` がないため **`ws` パッケージが必要**（`neonConfig.webSocketConstructor = ws`）。

## 4. リポジトリ構成

フロントエンドと Lambda を**同じリポジトリ**で管理する。Lambda のコードも IDE で書き、Git で管理する。AWS のコンソールでコードを書くことはしない。

```
English-study-app/
├── src/                    フロントエンド（Next.js、静的書き出し）
│   ├── app/                画面
│   ├── components/         UI コンポーネント
│   └── lib/                API クライアント
├── public/                 静的ファイル（Service Worker、アイコン、_headers）
├── shared/                 ★ フロントと Lambda で共有する型・Zod スキーマ
├── functions/              Cloudflare Pages Functions（Lambda への中継）
├── lambda/                 ★ バックエンド
│   ├── src/
│   │   ├── router.ts       パス → ハンドラの振り分け
│   │   ├── handlers/       各 API の処理
│   │   ├── lib/            ロジック（出題選択、Gemini、通知）
│   │   └── repositories/   DB アクセス
│   ├── prisma/             スキーマ、マイグレーション、シード
│   └── template.yaml       AWS SAM の構成定義
├── e2e/                    Playwright
└── doc/
```

**型と Zod スキーマは `shared/` に置き、両方の `tsconfig.json` の `paths` で解決する。** `zod` のバージョンがフロントと Lambda でずれると型が非互換になるため、**同一バージョンに固定する**。

### Lambda の構成（重要）

**Lambda Function URL は1関数に1 URL が対応するだけで、パスによる振り分け機能を持たない。** そのため以下の構成にする。

| 関数 | Function URL | 役割 |
| --- | --- | --- |
| `ApiFunction` | あり（1つだけ） | `router.ts` が `/api/*` のパスを見てハンドラへ振り分ける |
| `NotifyFunction` | **なし** | EventBridge からのみ起動 |
| `GenerateFunction` | **なし** | EventBridge からのみ起動 |

API を増やすときは `template.yaml` ではなく **`router.ts` にルートを登録する**。

## 5. 認証・ユーザー設計

**Cloudflare Access を使い、認証コードは書かない。**

```
1. ブラウザがサイトにアクセス
2. Cloudflare Access がログイン画面を出す（Google ログイン等）
3. 認証後、Cloudflare が JWT を発行し Cookie に保存
4. /api/* へのリクエストで Pages Functions が
   cf-access-jwt-assertion ヘッダを Lambda へ転送
5. Lambda が JWT の署名を検証し、メールアドレスを取り出す
6. そのメールアドレスで User を特定する
```

- **Lambda は必ず JWT を検証する。** Lambda の URL は公開されているため、検証しなければ誰でも叩ける
- ユーザーの識別子は JWT 内のメールアドレス。`User` テーブルに upsert する
- 学習データはすべて `userId` を持ち、クエリは必ず `userId` スコープを通す
- **ユーザーIDをハンドラにベタ書きしない。** JWT から解決する共通ヘルパーを1つ用意し、全ハンドラがそこを通す

この構成なら、最初から実質的にマルチユーザー対応になる。認証を後から足す手戻りが発生しない。

## 6. データモデル

| モデル | 主な項目 | 用途 |
| --- | --- | --- |
| User | id, email, timezone, notificationTime, lastNotifiedDate, createdAt | 認証されたユーザー。`lastNotifiedDate` は通知の二重送信防止 |
| Vocabulary | userId, word, wordType, meaning, coreImage, examples, source, generationFailCount, lastGenerationAttemptAt, createdAt, updatedAt, deletedAt | 登録した単語・イディオム。`source` は任意で出典（映画・YouTube 等）。削除は論理削除 |
| Question | vocabularyId, format, prompt, choices, answer, explanation, generatedAt, lastServedAt | Gemini が生成した出題。`lastServedAt` は再出題の間隔制御用 |
| Attempt | userId, questionId, dailySetId, answer, isCorrect, answeredAt | 解答履歴。`dailySetId` で復習と自由学習を区別する |
| DailySet | userId, date, questionIds, createdAt | その日の10問を固定し、途中再開を可能にする |
| PushSubscription | userId, endpoint, keys, createdAt | Web Push の配信先。端末・ブラウザごとに1行 |
| RateLimit | userId, bucket, windowStart, count | API のレート制限。Lambda はインスタンス間で状態を共有しないため DB に持つ |

設計上の要点:

- `Question` は `userId` を持たず、`Vocabulary` 経由でユーザーに紐づく（**唯一の例外**）
- `Vocabulary` は**論理削除**（`deletedAt`）。物理削除すると `Attempt` の学習履歴が失われる
- `Attempt.dailySetId` が `null` なら自由学習、値があれば復習セッションの解答。**現状は自由学習画面を作らないため常に非 null**（将来の拡張用に nullable のまま残す）
- `Vocabulary.generationFailCount` は、Gemini の生成に繰り返し失敗する単語を夜間バッチの対象から外すために使う。これがないと、生成できない単語が毎晩最優先で選ばれ続けて API を浪費する
- `RateLimit` は**ステップ3の時点でスキーマに入れる**。実装はステップ10でよいが、後から追加するとマイグレーションが増える
- PostgreSQL なので `examples` / `choices` / `questionIds` は **JSON 型**が使える（SQLite と違い文字列に詰め込む必要がない）

## 7. シークレット管理

### 秘密情報（Lambda にのみ置く）

本番は **AWS Secrets Manager または SSM Parameter Store (SecureString)** に保管し、`template.yaml` からは動的参照（`{{resolve:secretsmanager:...}}`）で読む。**`template.yaml` は Git 管理下に入るため、リテラル値を書かない。**

| 変数 | ローカル | 用途 |
| --- | --- | --- |
| `GEMINI_API_KEY` | `lambda/.env` | Gemini API キー |
| `VAPID_PRIVATE_KEY` | `lambda/.env` | Web Push の署名鍵 |
| `DATABASE_URL` | `lambda/.env` | Neon の **pooled** 接続文字列 |

### 共有シークレット（Pages と Lambda の両方に同じ値を置く）

| 変数 | 置き場所 | 用途 |
| --- | --- | --- |
| `INTERNAL_API_KEY` | Lambda 環境変数 **と** Pages Functions の環境変数 | 中継経路の認証 |

**両方に入れないと本番の全 API が 403 になる。** Pages 側に入れ忘れると「Access のログインは通るのに全部エラー」という切り分けにくい症状になる。

ローテーションが必要になった場合は、**Lambda 側で新旧2つのキーを一時的に許容 → Pages を新キーに更新 → Lambda から旧キーを削除**の順で行う。片方だけ切り替えると即座に全断する。

### 設定値（秘密ではないが必須）

| 変数 | 置き場所 | 用途 |
| --- | --- | --- |
| `CF_ACCESS_TEAM_DOMAIN` | Lambda 環境変数 | JWKS の取得元 |
| `CF_ACCESS_AUD` | Lambda 環境変数 | JWT の `aud` 検証 |
| `CF_ACCESS_JWKS_URL` | Lambda 環境変数（任意） | ローカルでテスト用鍵に差し替えるため |
| `LAMBDA_FUNCTION_URL` | **Pages Functions の環境変数** | 中継先。実行時に読まれる |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Pages のビルド環境変数 | ブラウザに埋め込まれる |

> ⚠️ **`CF_ACCESS_JWKS_URL` は fail-open のリスクがある。** 未設定や誤設定なら 401（安全側）になる他の変数と違い、これがテスト用 JWKS を指したまま本番に出ると**認証バイパス**になる。Lambda の起動時に、本番ではホスト名が `*.cloudflareaccess.com` であることを検証し、違えば起動を拒否する。

### 重要な注意

- **`NEXT_PUBLIC_` を付けてよいのは VAPID 公開鍵のみ。**
- **API のベース URL を `NEXT_PUBLIC_` にしない。** フロントは常に**相対パス `/api/...`** を叩く。Lambda の Function URL を直接叩くと Cloudflare Access の Cookie が付かず、認証を素通りする経路がブラウザに埋め込まれてしまう
- **`NEXT_PUBLIC_*` は `next build` 時に静的に展開される。** 手元でビルドして `out/` をアップロードすると Pages 側の環境変数は反映されない。**デプロイは Pages の Git 連携でビルドさせる**こと
- Gemini のキーは **Lambda にしか置かない**。ブラウザにも Cloudflare にも渡らない
- `.env*` は `.gitignore` 済み。`.env.example` はコミットする

## 8. Gemini 利用方針

- 呼び出すのは **Lambda のみ**。ブラウザからも Cloudflare からも直接呼ばない
- API キー、利用量、エラーをクライアントに公開しない
- 問題生成の入力には単語、意味、コアイメージ、既存問題の要約を渡す
- **生成は原則としてバックグラウンド（夜間バッチ）で行う。** 出題時は保存済み問題を返すだけにする
- 一度出した問題は `MIN_REPEAT_INTERVAL_DAYS` 以内に再出題しない
- 構造化 JSON を要求し、不正 JSON・重複・API エラーには再試行とフォールバックで対処する

## 9. 実装ステップ

各ステップの詳細は [`doc/steps/`](./steps/README.md) を参照。

1. **開発基盤（完了）** — Next.js、TypeScript、Tailwind CSS、ESLint

2. **疎通確認（最優先）** — Pages への静的デプロイ、Lambda の作成とデプロイ、**Lambda から Gemini を呼べるかの検証**、Cloudflare Access の設定

3. **データベース** — Neon の作成、Prisma スキーマ、マイグレーション、シード

4. **テスト基盤** — Vitest、Playwright、TDD の開始

5. **単語帳** — 登録・編集・一覧（Lambda の API + クライアントコンポーネント）

6. **出題エンジン** — Gemini 連携、出題選択ロジック、再出題の間隔制御

7. **解答の仕組みと共通コンポーネント** — 解答 API、正誤判定、履歴画面、出題表示コンポーネント（学習画面はステップ8）

8. **毎日10問復習** — セットの固定と途中再開

9. **定期実行** — Web Push、EventBridge Scheduler、通知バッチ、問題生成バッチ

10. **品質・公開** — 入力検証の総点検、レート制限、エラー監視、カバレッジ確認

## 10. 決定事項

1. 配信は Cloudflare Pages（静的書き出し）、API は AWS Lambda（東京リージョン）、DB は Neon (PostgreSQL)。
2. 認証は Cloudflare Access。認証コードは自分で書かない。最初からマルチユーザー前提の設計にする。
3. 通知の初期設定は毎日 06:00、タイムゾーンは Asia/Tokyo。
4. 定期実行は EventBridge Scheduler。
5. Lambda のコードは同じリポジトリで管理し、AWS SAM でデプロイする。

## 11. 未確定事項

1. **Gemini の無料枠**: モデルごとの1日あたりリクエスト上限は AI Studio のダッシュボードで確認する。ステップ2で実測する。
2. **出題形式（`Question.format`）の具体的な一覧**: ステップ6の着手前に確定する。
3. **`shared/` を Lambda のバンドルに含める方法**: `sam build` の esbuild が `lambda/` の外を tsconfig の `paths` 経由で解決できるかは実測が必要。できなければ `BuildMethod: makefile` に切り替える（ステップ2・3）。
4. **Cloudflare が偽造 `cf-access-jwt-assertion` ヘッダを除去するか**: 公式ドキュメントに記載がない。ステップ2で実測して結果を記録する。**除去されなくても構成は安全**（防御の本体は Lambda 側の署名・`aud`・`iss` 検証）。
5. **各サービスの無料枠の実数値**: 上記「費用」の表は調査時点の値。ステップ2で公式ページを見て更新する。

### 決定済み（旧・未確定事項）

- **型の共有方法** → `shared/` に置き、両 `tsconfig.json` の `paths` で解決する（§4）
- **自由学習画面（`/study`）** → **作らない。** 復習（`/review`）に一本化する（YAGNI）
- **AWS Lambda の無料枠** → **恒久**（100万リクエスト/月、40万GB秒）。ただし新規アカウントの Free Plan 自動クローズに注意（§2）
- **Neon の接続方式** → **pooled + WebSocket**（`PrismaNeon`）。HTTP はトランザクション非対応（§3）
