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

### 4-3. ★ Function URL は `AuthType: AWS_IAM`（決定済み）

**Function URL は `AWS_IAM` にし、Cloudflare Pages Functions が SigV4 署名を付ける。**
署名の無いリクエストは AWS 側で 403 になり、**Lambda は起動しない。**

```
署名なしの攻撃 → Function URL → AWS が署名を検証 → 403
                                 ★関数は起動しない = 課金ゼロ

正規のリクエスト → Pages Functions（SigV4 署名を付ける）
                    → Function URL → AWS が検証 → Lambda 起動
                      → router.ts が X-Internal-Api-Key を検証
                        → getAuthenticatedUser() が JWT を検証
```

#### なぜ変えたか

`AuthType: NONE` では、共有シークレットを持たないリクエストでも**関数が起動してから**弾かれていた。結果として、

- Lambda のリクエスト課金とコンピュート課金が発生する
- コールドスタートのたびに SSM を呼ぶため、**SSM のスループット上限を
  食い潰し、正規のリクエストまで期待値を取得できなくなる**（可用性に波及）

`ReservedConcurrentExecutions` はコストの天井にはなるが、低くすると自ら
スロットリングを招くため根本解決にならなかった。

なお `template.yaml` には長らく「ブラウザから Pages Functions 経由で叩くため
IAM 署名は使えない」と書かれていたが、**これは誤り**だった。署名するのは
ブラウザではなく Pages Functions（サーバー側）であり、Workers の WebCrypto に
HMAC-SHA256 があるため SigV4 は実装できる。

#### 実装

| 場所 | 内容 |
| --- | --- |
| `lambda/template.yaml` | `AuthType: AWS_IAM`。署名用の IAM ユーザー `RelayIamUser` を定義 |
| `functions/api/[[path]].ts` | `aws4fetch` で署名して転送 |
| Cloudflare Pages の環境変数 | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`（後者は Secret 型） |

**アクセスキーは CloudFormation で作らない。** `AWS::IAM::AccessKey` を使うと
シークレットがスタックに保存され読み出せてしまう（`lib/secrets.ts` が Lambda の
環境変数を避けたのと同じ理由）。手動で `aws iam create-access-key` する。

IAM ユーザーの権限は**この関数の `lambda:InvokeFunctionUrl` 1つだけ**。
`lambda:FunctionUrlAuthType: AWS_IAM` の条件も付けてあり、`AuthType` を誤って
`NONE` に戻してもこのユーザー経由の経路は IAM 認証のままになる。

**ここを広げると、鍵が漏れたときの被害が `INTERNAL_API_KEY` の漏洩より大きくなり、
SigV4 を入れた意味が失われる。**

#### `aws4fetch` を選んだ根拠（実測）

| 確認項目 | 結果 |
| --- | --- |
| 依存パッケージ | **ゼロ**（バンドル 11KB） |
| AWS SDK（`@smithy/signature-v4`）との署名一致 | **6ケース全一致**（URLエンコード済みパス、記号入りクエリ、クエリ順序、末尾スラッシュを含む） |
| 署名キーのキャッシュ | 内蔵（`Map`、キーは `secret, date, region, service`） |
| 署名1回のコスト | **0.25〜0.31ms**（Node の WebCrypto 実測。10ms 予算の約3%） |
| キャッシュ無効時 | 0.49ms（約2倍）→ `AwsClient` はモジュールスコープで使い回す |

`env` はリクエストごとにしか渡らないためモジュールスコープで初期化できない。
初回リクエストで作って以降キャッシュする実装にしてある。

> 上記は Node の WebCrypto での計測。本番の CPU 時間は
> Cloudflare の Workers Analytics で確認すること（`wrangler pages dev` は
> CPU 時間を報告しない）。

#### ★ リクエストボディをストリームできなくなった

SigV4 は本文の SHA-256 を署名に含めるため、署名前に本文を読み切る必要がある。
`duplex: "half"` によるストリーム転送は使えない。

その結果 CPU が本文サイズに比例するようになったので、
**`MAX_REQUEST_BODY_BYTES = 128 * 1024` で上限を設けた**（`content-length` で
先に弾き、無い場合は読み切った後のバイト数で判定。超えたら 413）。

このアプリで上りに乗る最大は単語登録フォームの数 KB なので余裕は十分ある。
**将来「単語の一括インポート」を作るなら、上限を上げる前に CPU を実測すること**
（512KB で予算の約14%を使う）。

なおレスポンスは署名対象ではないため、**下りは従来どおり素通しのまま**。
「毎日10問」のデータ量は署名コストに影響しない（そもそも
`doc/steps/08-daily-review.md` の設計で1問ずつ返す）。

#### ローカル開発

`wrangler pages dev` で本番と同じ中継経路を確認するため、転送先が
ループバック（`127.0.0.1` / `localhost` / `[::1]`）の場合も許可している。

**これは認証の迂回ではない。** 署名処理は本番と同じ経路を通り、
`X-Internal-Api-Key` も JWT も同様に要求される。違うのは転送先のホストの形だけで、
検証を省く分岐はどこにも無い（`index.ts` の設計思想を維持している）。

ループバック宛ての署名には**実在しないリージョン `local`** を使う。
`local-server.ts` は署名を検証しないので値は何でもよいが、実在するリージョン名に
すると設定を取り違えたときに本物の AWS へ有効な署名を送れてしまうため、
意図的に通らない値にしてある。

`.dev.vars` にはダミーの AWS 認証情報を入れる（空だと設定漏れとして 500 になる）。

#### 検証済みの挙動（`wrangler pages dev` + スタブ上流で実測）

- JWT 無し → 401（Lambda に到達しない）
- JWT あり → 200。`Authorization: AWS4-HMAC-SHA256 ...` が上流に届く
- `SignedHeaders` に `x-internal-api-key` と `cf-access-jwt-assertion` が含まれる
  （既存の合言葉が署名で保護される）
- クライアントが偽の `X-Internal-Api-Key` を送っても、上流には**本物だけ**が届く
  （ヘッダを複製せず組み立て直しているため）
- 許可リスト外のヘッダは転送されない
- 200KB の本文 → 413、100KB → 200
- `/api/a/b/c?x=1&y=2` のような未知のパスとクエリも正しく転送される

#### 転送先のホスト名を検証している

`LAMBDA_FUNCTION_URL` が `<id>.lambda-url.<region>.on.aws` の形（またはループバック）
でなければ 500 で止める。検証しないと、誤設定で JWT と共有シークレットを無関係な
ホストへ送ってしまう。

署名に使うリージョンは**このホスト名から導出する。** 別の環境変数にすると URL と
リージョンが食い違う誤設定を作れてしまい、本番で原因の分かりにくい 403 になる。

#### 独立して必要なこと

**AWS Budgets のアラートを設定する。** 異常課金に気づけないことは、
どの認証方式を選んでも解決しない。

#### 採用しなかった案

**IP 制限**（Cloudflare の IP 範囲のみ許可）も Lambda 起動前に弾ける。CPU ゼロ、
AWS キー不要という利点があったが、

- Cloudflare の**他の利用者**からは到達できる（自分の Worker だけを識別できない）
- IP 範囲の更新を忘れると障害になる

長期運用では「権限を絞った AWS キーを1本預ける」ほうが保守が要らないと判断した。

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
- [ ] **ヘッダが無いリクエストで SSM が呼ばれない**（`hasInternalKeyHeader()` が先に落とす。4-3 参照）
- [ ] **Function URL を署名なしで直叩きすると 403 が返り、Lambda が起動しない**（CloudWatch にログが出ないことで確認する。4-3 参照）
- [ ] **Pages Functions 経由なら 200 が返る**（SigV4 署名が AWS の検証を通っている）
- [ ] **`AWS_SECRET_ACCESS_KEY` が Pages の Secret タイプで登録されている**（管理画面で値が表示されない）
- [ ] **署名用 IAM ユーザーの権限がこの関数の `InvokeFunctionUrl` のみ**である
- [ ] 128KB を超えるリクエストボディが 413 で拒否される
- [ ] **本番の CPU 時間を Workers Analytics で確認した**（署名の追加分が 10ms 予算に収まっている）
- [ ] 正しい JWT でアクセスすると `User` が自動で作られる
- [ ] 同じメールで2回アクセスしても `User` が重複しない（upsert がべき等）

## 注意点

- **Prisma のバージョン固定**（上記）。`npm install -D prisma` をそのまま実行しない
- **Neon の無料枠はアイドル時に自動停止する。** 久しぶりのアクセスで数百msの遅延が出る。毎日使う用途なら実用上の問題は小さい
- Lambda のバンドルサイズに注意。Prisma 7 は Rust エンジンを廃止して軽くなった（約1.6MB）が、`sam build` の出力サイズは一度確認しておく
- **JWT の `aud` 検証を忘れない。** 署名だけ検証して `aud` を見ないと、同じ Cloudflare チームの別アプリのトークンで通ってしまう
- 開発中は Access を通さずに Lambda を叩きたくなるが、**認証を迂回するフラグを作らない。** JWKS URL を差し替える方式にする（上記4）
- **`CF_ACCESS_TEAM_DOMAIN` と `CF_ACCESS_AUD` を `template.yaml` に入れ忘れない。** 漏れると本番の Lambda で JWKS URL が `undefined` になり全 API が 401 になる。「ログインは通るのに全部エラー」という切り分けにくい症状になる
