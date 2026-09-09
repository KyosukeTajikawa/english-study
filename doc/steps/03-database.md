# ステップ3: データベース

## 目的

Neon (PostgreSQL) を用意し、Prisma でスキーマを定義する。Lambda から DB を読み書きできる状態にする。JWT からユーザーを解決する仕組みもここで作る。

## 前提

- ステップ2完了（Lambda がデプロイでき、Access が効いている）

## 追加・変更するファイル

| パス | 種別 | 役割 |
| --- | --- | --- |
| `lambda/prisma/schema.prisma` | 新規 | データモデル定義 |
| `lambda/prisma.config.ts` | 新規 | **Prisma 7 で必須。** datasource の url もここ |
| `lambda/prisma/migrations/` | 生成 | マイグレーション |
| `lambda/prisma/seed.ts` | 新規 | 開発用シード |
| `shared/schemas/` | 新規 | フロントと共有する Zod スキーマ |
| `lambda/src/lib/db.ts` | 新規 | Prisma Client の生成 |
| `lambda/src/lib/auth.ts` | 新規 | **JWT 検証とユーザー解決（最重要）** |
| `lambda/src/lib/internal-auth.ts` | 新規 | 共有シークレットの検証（定数時間比較） |
| `lambda/src/repositories/user.ts` | 新規 | User の upsert・更新・取得 |
| `shared/types.ts` | 変更 | モデルに対応する型を追加 |
| `lambda/package.json` | 変更 | Prisma の依存、`db:seed`、`prisma generate` を含むビルドスクリプト |
| `lambda/template.yaml` | 変更 | `DATABASE_URL` / `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` / `INTERNAL_API_KEY` を追加 |
| `.env.example` / `lambda/.env.example` | 変更 | 増えた変数を追記 |
| `README.md` | 変更 | セットアップ手順 |

## 依存パッケージ

`lambda/` で:

```bash
npm install @prisma/client@7.10.0 @prisma/adapter-neon@7.10.0 @neondatabase/serverless ws jose zod
npm install -D prisma@7.10.0 @types/ws
```

> **重要**: `prisma` の npm `latest` タグは **`8.0.0-rc`** を指している。`npm install -D prisma` とすると RC が入り `@prisma/client@7.10.0` と不整合を起こす。**必ず `7.10.0` を明示する。**

- `ws` は WebSocket 接続に必要（Node にグローバル `WebSocket` がないため）
- `jose` は JWT の署名検証に使う
- `zod` は `shared/` のスキーマで使うため、**フロント側と同一バージョン**を入れる

## 実装方針

### 1. Neon のセットアップ

1. [Neon](https://neon.tech) でプロジェクトを作成（リージョンは東京が近い）
2. **pooled 接続文字列**（`...-pooler.<region>.aws.neon.tech`）を取得し、`lambda/.env` の `DATABASE_URL` に設定
3. E2E 用に**ブランチ**を作り、`DATABASE_URL_TEST` に設定（無料枠で10ブランチまで）
4. 本番用は Lambda の環境変数に設定（`template.yaml`）

### 1-2. ★ 接続方式は pooled + WebSocket（HTTP ではない）

**`@prisma/adapter-neon` の HTTP モードはトランザクションを一切サポートしない。** 実コードが明示的に拒否する:

```js
async startTransaction() {
  return Promise.reject(new Error("Transactions are not supported in HTTP mode"));
}
```

対話型・配列形式のどちらの `$transaction()` も失敗する。ステップ8で `DailySet` 作成と `lastServedAt` 更新を同一トランザクションで行うため、**HTTP は使えない。**

| export | 実体 | トランザクション |
| --- | --- | --- |
| **`PrismaNeon`** | `neon.Pool`（WebSocket） | **可 ← これを使う** |
| `PrismaNeonHttp` | `neon()`（HTTP） | 不可 |

当初 HTTP を検討した理由（Lambda の同時実行数だけコネクションが張られる）は、**pooled エンドポイントの PgBouncer が吸収する**ので解消する。

### 1-3. ★ Prisma 7 の必須設定

Prisma 7 には破壊的変更があり、以下を満たさないと動かない。

| 項目 | 内容 |
| --- | --- |
| `prisma.config.ts` | **必須。** migrate / introspect が事実上これを要求する |
| generator の `output` | **必須。** Prisma Client は `node_modules` に生成されなくなった。出力先を明示し、`sam build` のバンドルに含める |
| generator の provider | **`prisma-client`**（`prisma-client-js` は将来削除） |
| datasource の `url` | `schema.prisma` の datasource ブロックでは**非推奨**。`prisma.config.ts` に移す（放置すると `P1012` エラー） |

**generator の `output` はバンドル方針に直結する。** `node_modules` に出ない以上、生成先を `sam build` の対象に含める設定が必要。

### 2. スキーマ

`provider = "postgresql"`。PostgreSQL なので SQLite と違い **JSON 型がネイティブに使える**。

| モデル | 主なフィールド | 備考 |
| --- | --- | --- |
| `User` | `id`, `email` (unique), `timezone`, `notificationTime`, `lastNotifiedDate?`, `createdAt` | `timezone` 既定 `"Asia/Tokyo"`、`notificationTime` 既定 `"06:00"` |
| `Vocabulary` | `userId`, `word`, `wordType`, `meaning`, `coreImage?`, `examples` (Json), `source?`, `generationFailCount`, `lastGenerationAttemptAt?`, `createdAt`, `updatedAt`, `deletedAt?` | 論理削除 |
| `Question` | `vocabularyId`, `format`, `prompt`, `choices` (Json), `answer`, `explanation`, `generatedAt`, `lastServedAt?` | `userId` は持たない |
| `Attempt` | `userId`, `questionId`, `dailySetId?`, `answer`, `isCorrect`, `answeredAt` | `dailySetId` が null なら自由学習。`@@unique([dailySetId, questionId])` で同一セット内の再解答を DB で防ぐ |
| `DailySet` | `userId`, `date`, `questionIds` (Json), `createdAt` | `@@unique([userId, date])` |
| `PushSubscription` | `userId`, `endpoint` (unique), `keys` (Json), `createdAt` | 端末ごとに1行 |
| `RateLimit` | `userId`, `bucket`, `windowStart`, `count` | `@@unique([userId, bucket, windowStart])` |

設計上の要点:

- **`Vocabulary` は論理削除（`deletedAt`）にする。** 物理削除すると `Question` → `Attempt` の連鎖で学習履歴が失われる。一覧取得では常に `deletedAt: null` で絞る
- **`Question` だけ `userId` を持たない。** `Vocabulary` 経由でユーザーに紐づく。これは正規化の観点で正しいが、「学習データは全て `userId` を持つ」という原則の唯一の例外なので、取得時は必ず `vocabulary: { userId }` で絞る
- **`Attempt.dailySetId`** で復習と自由学習を区別する。現状は自由学習画面を作らないため常に非 null だが、将来の拡張用に nullable のまま残す
- **`RateLimit` はステップ3の時点で入れる。** 実装はステップ10だが、後から足すとマイグレーションが増える。**Lambda はインスタンス間で状態を共有しない**（同時実行が別コンテナに散る）ため、メモリ上のカウンタでは機能しない。DB に持つことが必須
- **`Vocabulary.generationFailCount`** は、生成に繰り返し失敗する単語を夜間バッチの対象から外すために使う。これがないと、問題数0のまま毎晩最優先で選ばれ続けて Gemini を浪費する
- **命名**: `Vocabulary.wordType`（word/idiom）と `Question.format`（出題形式）。どちらも `type` にすると混同するので分けた

インデックス:

| インデックス | 用途 |
| --- | --- |
| `Vocabulary(userId, deletedAt)` | 一覧取得 |
| `Attempt(userId, answeredAt)` | 履歴の新着順 |
| `Attempt(userId, questionId)` | 問題ごとの成績 |
| **`Attempt(dailySetId)`** | 復習の進捗導出。**復習画面を開くたびに必ず走る最頻クエリ** |
| `Question(vocabularyId)` | 単語に紐づく問題 |
| **`Question(vocabularyId, lastServedAt)`** | 間隔条件での候補抽出。単独の `lastServedAt` より実クエリに合う |
| **`PushSubscription(userId)`** | 通知バッチが購読を引く |

### 3. Prisma Client の生成 (`lambda/src/lib/db.ts`)

Lambda はリクエストごとにコンテナが再利用されるため、**Prisma Client はモジュールトップレベルで1回だけ生成してよい**（Workers と違う点）。

```
neonConfig.webSocketConstructor = ws
  → new Pool({ connectionString: DATABASE_URL })   ← pooled 接続文字列
  → new PrismaNeon(pool)
  → new PrismaClient({ adapter })
```

`ws` の設定を忘れると Node 環境で接続できない（グローバル `WebSocket` がないため）。

### 4. ★ JWT 検証とユーザー解決 (`lambda/src/lib/auth.ts`)

**このステップで最も重要なファイル。**

```
getAuthenticatedUser(event) → { userId, email }
  1. cf-access-jwt-assertion ヘッダを取り出す
  2. Cloudflare の公開鍵（JWKS）で署名を検証する
  3. aud（Access アプリケーションの ID）が一致するか確認する
  4. exp（有効期限）を確認する
  5. JWT から email を取り出す
  6. User を email で upsert し、userId を返す
```

- **検証を省略しない。** Lambda の Function URL は公開されている。ヘッダの中身をそのまま信じると、誰でも任意のメールアドレスを名乗れる
- JWKS は `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs` から取得する。`jose` の `createRemoteJWKSet` がキャッシュも面倒を見る
- **`iss`（発行者）も検証する。** 署名と `aud` だけでなく多層で確認する
- 検証に失敗したら **401 を返して処理を中断する**
- **すべての HTTP ハンドラがこの関数を最初に呼ぶ。** ユーザーIDをどこにもベタ書きしない（バッチハンドラは対象外。後述）

#### JWKS の取得先を環境変数にする

`CF_ACCESS_JWKS_URL` を環境変数にし、**ローカル開発ではテスト用の鍵に差し替える。**

「開発中は認証をスキップする」というフラグは**作らない。** 消し忘れが認証バイパスになる。JWKS を差し替える方式なら**検証ロジック自体は本番と同一**なので、この事故が起きない。

> ⚠️ **ただしこの方式は fail-open のリスクを持つ。** `CF_ACCESS_TEAM_DOMAIN` や `CF_ACCESS_AUD` の入れ忘れは全 API が 401（安全側）になるが、**`CF_ACCESS_JWKS_URL` がテスト用 URL を指したまま本番に出ると認証バイパスになる。**
>
> 対策: Lambda の起動時（コールドスタート時）に、本番では JWKS URL のホスト名が `.cloudflareaccess.com` で終わることを検証し、違えば**起動を拒否する**。`template.yaml` でも本番スタックにこの変数の既定値を持たせない。

#### HTTP ハンドラとバッチハンドラの区別

| 種別 | 起動元 | 認証 |
| --- | --- | --- |
| **HTTP ハンドラ** | Function URL 経由 | `internal-auth` → `getAuthenticatedUser()` の順に必ず通す |
| **バッチハンドラ**（`cron-*.ts`） | EventBridge のみ | **JWT を持たない。** Function URL を持たないことを `template.yaml` で担保する |

バッチは全ユーザー横断で動くため JWT を通せない。ただし**DB クエリは `userId` スコープでループする**点は同じ。

### 4-2. 共有シークレットの検証 (`internal-auth.ts`)

`X-Internal-Api-Key` を `INTERNAL_API_KEY` と比較する。**JWT 検証より前に実行する。**

- 比較は**定数時間**で行う（`crypto.timingSafeEqual`）。長さが違う場合も一定時間で失敗させる
- 不一致なら 403 を返し、DB にも Gemini にも触れずに終了する

### 5. 型の共有

**置き場所を役割で分ける。** 曖昧にすると同じ制約が2箇所に分岐する。

| 置き場所 | 内容 |
| --- | --- |
| `shared/types.ts` | API のリクエスト・レスポンスの型 |
| `shared/schemas/*.ts` | **フロントと共有する入力スキーマ**（フォームの検証にも使う） |
| `lambda/src/lib/validation/*.ts` | **Lambda 内部専用の検証**（Gemini のレスポンス、DB から読んだ JSON） |

- 両方の `tsconfig.json` の `paths` で `shared/*` を解決する
- **`zod` はフロントと Lambda で同一バージョンに固定する。** バージョンがずれると型が非互換になる。そのため `zod` の導入はこのステップで行う（ステップ5ではない）
- 型は `z.infer` で導出し、**同じ制約を二度書かない**
- Prisma が生成する型をそのまま公開しない。**API の境界用の型を別に定義する**（DB のカラムをそのままブラウザに晒さないため）

**`shared/` が `lambda/` の外にある点に注意。** SAM の esbuild ビルドは `CodeUri` 配下を前提にするため、`shared/` をバンドルに含める設定が必要になる。**このステップで実際にデプロイして動くことを確認する**（DoD に含めた）。

### 6. マイグレーションとシード

Neon は通常の PostgreSQL なので、Prisma の標準的な手順がそのまま使える。

```bash
npx prisma migrate dev --name init      # ローカル開発
npx prisma migrate deploy               # 本番
npm run db:seed                         # 開発用データ
```

`prisma/seed.ts` は**べき等**にする（再実行しても壊れない）。ステップ6の開発でダミーの `Question` を投入する土台にもなる。

### 7. ★ `sam build` は `prisma generate` を実行しない

`sam build`（esbuild 方式）は `npm install` 後のポストインストールや `prisma generate` を**自動では走らせない。** 生成されたクライアントがバンドルに含まれないと、デプロイ後に `@prisma/client did not initialize yet` で落ちる。

**ローカルでは `node_modules` に生成物があるため気づけない。**

`lambda/package.json` にビルドスクリプトを用意し、`sam build` の前に必ず `prisma generate` を実行する。デプロイ手順にも組み込む。

## テスト

テスト基盤は次のステップなので、ここでは手動確認にとどめる。ただし `auth.ts` は**ステップ4で最初にテストを書く対象**にする。

## 完了条件 (DoD)

- [ ] Neon にスキーマが適用されている（`RateLimit` を含む7モデル）
- [ ] **デプロイした Lambda から** DB を1件読み書きできる（`prisma generate` の漏れをここで検出する）
- [ ] **`$transaction()` が動く**（pooled + WebSocket が正しく設定されている。ステップ8の前提）
- [ ] 本番で `CF_ACCESS_JWKS_URL` が Cloudflare 以外を指すと起動を拒否する
- [ ] **`sam build` の成果物に `shared/` の内容が含まれ、デプロイ後も動く**
- [ ] シードが流せ、再実行しても壊れない
- [ ] **JWT が不正・欠落・`aud` 違い・`iss` 違いの場合に 401 が返る**
- [ ] **`X-Internal-Api-Key` がない／不一致なら 403 が返る**（JWT より前に弾かれる）
- [ ] 正しい JWT でアクセスすると `User` が自動で作られる
- [ ] 同じメールで2回アクセスしても `User` が重複しない（upsert がべき等）

## 注意点

- **Prisma のバージョン固定**（上記）。`npm install -D prisma` をそのまま実行しない
- **Neon の無料枠はアイドル時に自動停止する。** 久しぶりのアクセスで数百msの遅延が出る。毎日使う用途なら実用上の問題は小さい
- Lambda のバンドルサイズに注意。Prisma 7 は Rust エンジンを廃止して軽くなった（約1.6MB）が、`sam build` の出力サイズは一度確認しておく
- **JWT の `aud` 検証を忘れない。** 署名だけ検証して `aud` を見ないと、同じ Cloudflare チームの別アプリのトークンで通ってしまう
- 開発中は Access を通さずに Lambda を叩きたくなるが、**認証を迂回するフラグを作らない。** JWKS URL を差し替える方式にする（上記4）
- **`CF_ACCESS_TEAM_DOMAIN` と `CF_ACCESS_AUD` を `template.yaml` に入れ忘れない。** 漏れると本番の Lambda で JWKS URL が `undefined` になり全 API が 401 になる。「ログインは通るのに全部エラー」という切り分けにくい症状になる
