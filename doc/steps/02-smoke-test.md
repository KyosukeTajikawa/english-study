# ステップ2: 疎通確認

## 目的

アプリを作り始める前に、**構成が成立することを確かめる。** 4つの検証を行う。

1. Next.js の静的書き出しが Cloudflare Pages で配信できる
2. Lambda が作成・デプロイでき、ブラウザから呼べる
3. **Lambda から Gemini API を呼べる**（← 最重要）
4. Cloudflare Access でログインを掛けられる

3 が失敗すると構成そのものを見直すことになる。**ここを最初にやる理由がこれ。** アプリを作り込んでから発覚すると全部やり直しになる。

## 前提

- Cloudflare アカウント
- AWS アカウント
- Google Gemini API キー（[AI Studio](https://aistudio.google.com/apikey) で発行）
- Node.js 22.12 以上

## 追加・変更するファイル

| パス | 種別 | 役割 |
| --- | --- | --- |
| `next.config.ts` | 変更 | `output: "export"` を追加 |
| `lambda/template.yaml` | 新規 | AWS SAM の構成定義 |
| `lambda/src/router.ts` | 新規 | **パス → ハンドラの振り分け** |
| `lambda/src/lib/internal-auth.ts` | 新規 | **共有シークレットの検証**（定数時間比較） |
| `lambda/src/handlers/health.ts` | 新規 | 疎通確認用の最小ハンドラ |
| `lambda/package.json` | 新規 | Lambda 側の依存 |
| `lambda/tsconfig.json` | 新規 | Lambda 側の設定（`include` を `src/` と `shared/` に限定） |
| `lambda/eslint.config.mjs` | 新規 | **Lambda 側の lint**（typescript-eslint。ルートの Next.js 設定を使わない） |
| `tsconfig.json` | 変更 | **`exclude` の追加（下記）** と `shared/` の `paths` |
| `eslint.config.mjs` | 変更 | **`globalIgnores` に `lambda/**`、`functions/**`、`e2e/**` を追加** |
| `functions/tsconfig.json` | 新規 | Workers ランタイム用（`@cloudflare/workers-types`） |
| `shared/types.ts` | 新規 | フロントと Lambda で共有する型 |
| `functions/api/[[path]].ts` | 新規 | Pages Functions（Lambda への中継） |
| `.dev.vars.example` | 新規 | ローカルの Pages Functions 用（`.dev.vars` はコミットしない） |
| `lambda/.env.example` / `lambda/.env` | 新規 | Lambda 用。`.env.example` はコミットする |
| `.gitignore` | 変更 | `out/`、`.dev.vars`、`lambda/.aws-sam/`、`lambda/node_modules/` |
| `package.json` | 変更 | `build` の確認 |

フロント用の `.env.local` はこの時点では**不要**（`NEXT_PUBLIC_VAPID_PUBLIC_KEY` はステップ9で追加する）。

### ★ tsconfig / ESLint のスコープを先に直す

現在の `tsconfig.json` は `include` が `**/*.ts`、`exclude` が `node_modules` のみ。**`lambda/` を作った瞬間から `next build` が Lambda のコードまで型チェックし、ビルドが失敗する。**

- `@types/aws-lambda` は `lambda/node_modules` にしか入れないので、ルートの TS プログラムからは解決できない
- `exclude: ["node_modules"]` はルート直下の `./node_modules` にしかマッチせず、`lambda/node_modules/**/*.ts` が吸い込まれる
- `functions/` は Workers ランタイム前提のコードだが、ルートの `lib: ["dom"]` + Next 型で評価される

**ルートの `exclude` に `**/node_modules`、`lambda`、`functions`、`e2e`、`out` を追加する。** ESLint の `globalIgnores` も同様に拡張する。

**除外したら、その分の検査を必ず別途用意する。** 除外しただけだとロジックの大半（Lambda 側）が静的検査を一度も通らず、ステップ10の「lint が警告なしで通る」が**中身のない条件**になる。

| コードベース | 型チェック | lint |
| --- | --- | --- |
| `src/`（フロント） | `npm run typecheck` | `npm run lint` |
| `functions/` | `npm run typecheck:functions` | ルートの ESLint 対象外。型チェックのみ |
| `lambda/` | `cd lambda && npm run typecheck` | `cd lambda && npm run lint` |

`functions/` は `@cloudflare/workers-types` を使うため専用の `tsconfig.json` が要る（ルートの `lib: ["dom"]` では評価できない）。

## 依存パッケージ

Lambda 側（`lambda/` ディレクトリで）:

```bash
npm install @google/genai
npm install -D typescript @types/node @types/aws-lambda esbuild
```

AWS SAM CLI のインストールが必要（`brew install aws-sam-cli`）。AWS の認証情報も設定する（`aws configure`）。

## 実装方針

### 1. 静的書き出しに切り替える

`next.config.ts` に `output: "export"` を追加する。

**この時点で使えなくなるものを理解しておくこと。**

| 使えない | 代わりに |
| --- | --- |
| Server Component でのデータ取得 | ブラウザから Lambda の API を呼ぶ |
| Server Actions | 同上 |
| Route Handlers（`app/api/`） | Lambda に置く |
| 画像最適化（`next/image` の既定） | `images.unoptimized: true` を設定 |

動的ルート（`/vocabulary/[id]`）は、静的書き出しでは `generateStaticParams` が必要になる。**IDが事前に分からないので、詳細画面はクエリパラメータ（`/vocabulary/edit?id=xxx`）で作る**方が素直。ステップ5で採用する。

`npm run build` すると `out/` にファイルが出力される。これを Cloudflare Pages に上げる。

### 2. Lambda を作る

#### ★ 1関数 + 内部ルーター構成にする

**Lambda Function URL は1関数に1 URL が対応するだけで、パスによる振り分け機能を持たない。** `template.yaml` に「ルート」を書く場所はない。

そのため以下の構成を採る。

| 関数 | Function URL | 役割 |
| --- | --- | --- |
| `ApiFunction` | **1つだけ** | `router.ts` がパスを見てハンドラへ振り分ける |
| バッチ関数（ステップ9） | **なし** | EventBridge からのみ起動 |

`lambda/src/router.ts` は、メソッドとパスの対応表を持ち、該当がなければ 404、メソッド違いなら 405 を返す。**以降のステップで API を増やすときは `template.yaml` ではなく `router.ts` にルートを登録する。**

関数を API ごとに分けない理由: Function URL が増えて中継先が複数になり、Prisma を含むバンドルが関数の数だけデプロイされ、コールドスタートも関数ごとに発生するため。

`lambda/src/handlers/health.ts` には JSON を返すだけの処理を書き、`router.ts` に `GET /api/health` として登録する。

#### `template.yaml`

- リージョンは **`ap-northeast-1`（東京）**。Gemini のリージョン制限を回避するため必須
- ランタイムは **`nodejs22.x`**（`nodejs20.x` は 2026-04-30 に廃止済み）
- **Lambda Function URL** を使う（API Gateway ではない）。Function URL に追加料金はかからない
- `AuthType` は **`NONE`**（ブラウザから Cloudflare 経由で叩くため IAM 署名を使えない）。**その代わり下記の共有シークレットで守る**
- **`ReservedConcurrentExecutions` を設定する**（例: 5）。`AuthType: NONE` の URL はフラッド攻撃を受けうる。共有シークレットの検証は **Lambda が起動した後**に走るので、認可に失敗しても**呼び出し課金は発生する**。同時実行数に天井を設けてコストの最悪ケースを抑える
- **シークレットのリテラル値を書かない。** 本番は Secrets Manager / SSM の動的参照を使う
- IAM は最小権限にする（SAM の既定のまま広い権限にしない）

#### ★ 共有シークレットで直叩きを防ぐ

`AuthType: NONE` の Function URL は、**Cloudflare を経由せず誰でも直接叩ける。** JWT 検証だけに頼ると、JWT が何らかの経路で漏れた場合に Cloudflare 側のポリシーも WAF も一切効かないバイパス経路になる。

そこで多層防御として:

```
Pages Functions が X-Internal-Api-Key ヘッダを付けて転送
        ↓
Lambda は JWT 検証の「前」にこのヘッダを検証し、不一致なら 403
```

- 値は `INTERNAL_API_KEY`（`openssl rand -hex 32` 等で生成）
- Pages Functions 側は環境変数として保持する（ブラウザには渡らない）
- **比較は定数時間で行う**（タイミング攻撃対策）
- これにより、無認証のトラフィックが Neon のウェイクアップやコールドスタートを引き起こすのも防げる

なお **CORS 設定は直接アクセスには無意味**（ブラウザにしか効かない）。本番は同一オリジン中継なので CORS 自体が不要。

#### デプロイ

```bash
cd lambda
npx prisma generate     # ステップ3以降。sam build は自動実行しない
sam build
sam deploy --guided     # 初回のみ。以降は sam deploy
```

**`sam build`（esbuild 方式）にはコード生成フックがない。** `prisma generate` の実行と、`lambda/` の外にある `shared/` の取り込みの両方が必要なので、esbuild で解決できない場合は **`BuildMethod: makefile`**（`Makefile` の `build-<LogicalId>` ターゲット）に切り替える。こちらなら任意のコマンドを実行できるため両方まとめて解決できる。

発行された Function URL は **Pages Functions の環境変数 `LAMBDA_FUNCTION_URL`** に設定する。**フロントの `.env.local` には設定しない**（下記）。

### 3. ★ Gemini の疎通確認（最重要）

`health.ts` に Gemini を1回呼ぶ処理を足し、**デプロイした Lambda から実行する。**

> ⚠️ **この Gemini 呼び出しは検証専用。ステップ2の完了時に `health.ts` から削除する。** 残すと、認証を通らないハンドラから叩くたびに Gemini を消費するエンドポイントが本番に残る（ステップ6の日次上限も通らない）。`health.ts` 自体は疎通確認用に残してよいが、**DB にも Gemini にも触れない**状態にすること。

- ローカルで動いても意味がない。**必ずデプロイ後の Lambda で確認する。** ローカルは日本のIPだが、Lambda が本当に日本のIPから出ているかを確かめるのが目的
- `User location is not supported for the API use` が返ったら、この構成は成立しない。その場合は下の「失敗したときの選択肢」へ
- ついでに**利用可能なモデル名と、1日あたりのリクエスト上限**を確認する（未確定事項）

### 4. Cloudflare Pages と Access

1. **Pages の Git 連携でビルドさせる**（手元ビルド + `out/` アップロードにしない）。`NEXT_PUBLIC_*` はビルド時に展開されるため、Pages 側で環境変数を効かせるにはこの方式が必要
2. Cloudflare Zero Trust の管理画面で Access ポリシーを設定する
3. Google ログイン等を有効にし、自分のメールアドレスのみ許可する
4. **入口は3系統ある。それぞれに Access アプリケーションが必要。**
   - カスタムドメイン
   - 本番の `<project>.pages.dev`
   - **プレビューデプロイの `*.<project>.pages.dev`**（コミット/ブランチごとに生成される）

   Git 連携でビルドさせる方針なので**プレビューデプロイは必ず発生する。** 3つ目が抜けると、そこから未認証で静的ファイルと `/api/*` に到達できる
5. シークレットウィンドウでアクセスし、ログインを求められることを確認する
6. **偽造ヘッダの挙動を実測して記録する**: `cf-access-jwt-assertion` を自分で付けたリクエストを送り、Cloudflare が除去・上書きするかを確認する

   > Cloudflare の公式ドキュメントに「クライアント由来の `Cf-` ヘッダを除去する」という記述は**見つからない**。除去されない可能性がある。**除去されなくても構成は安全**で、防御の本体は Lambda 側の署名・`aud`・`iss` 検証である。結果をドキュメントに残すことが目的

### 5. Pages Functions（中継）

`functions/api/[[path]].ts` は、`/api/*` へのリクエストを Lambda に転送するだけの薄い処理。

```
1. リクエストの cf-access-jwt-assertion ヘッダを取り出す
2. 環境変数 LAMBDA_FUNCTION_URL 宛に、同じメソッド・パス・ボディで転送する
3. ★ 転送用のヘッダを「新規に組み立てる」。受信ヘッダを丸ごと複製しない
4. 組み立てたヘッダに JWT と X-Internal-Api-Key を付ける
5. Lambda のレスポンスをそのまま返す
```

**3 が重要。** 受信ヘッダをそのままコピーして転送すると、クライアントが送った偽の `X-Internal-Api-Key` と中継が付ける正しい値が**重複ヘッダ**として Lambda に届き、Lambda 側の取得実装によってはクライアント由来の方が採用されうる。**必要なヘッダだけを明示的に新規構築する。**

#### ★ フロントは常に相対パスを叩く

**`NEXT_PUBLIC_API_BASE_URL` は作らない。** フロントは `/api/...` という相対パスのみを使う（ベースパスの定数は `src/lib/api-client.ts` に1つ置く）。

理由が2つある。

1. **Function URL をフロントに埋め込むと、Access を素通りする経路がブラウザに露出する。** その URL を直接叩けば Cloudflare の認証を通らない
2. **`NEXT_PUBLIC_*` は `next build` 時に静的展開される。** 手元でビルドして `out/` を上げる運用だと、Pages 側に環境変数を設定しても成果物に反映されない

中継先の URL は **Pages Functions の環境変数**（`LAMBDA_FUNCTION_URL`）として持つ。こちらは実行時に読まれるので Pages の設定が正しく効く。

**ここで重い処理をしないこと。** Workers の CPU 10ms 制限が効くのはこの部分だけなので、転送に徹すれば余裕で収まる。

#### ★ ボディはパースせず素通しする

```
❌ const data = await response.json();
   return new Response(JSON.stringify(data));   // データ量に比例してCPUを消費

✅ return new Response(response.body, {          // ストリームのまま流す
     status: response.status,
     headers: response.headers,
   });
```

JSON をパースして再度文字列化すると、レスポンスが大きいほどCPUを食う。**素通しすればサイズに関係なくCPU消費はほぼ一定**になる。

#### CPU 制限に余裕がある理由（公式仕様）

- **静的ファイルの配信は Functions を起動しない。** 無料かつ無制限で、CPU 制限の対象外
- **`fetch()` の待ち時間は CPU 時間に算入されない。** Lambda が何秒かかっても Cloudflare 側の消費は増えない
- 中継処理そのものは1〜3ms程度

#### 通信まわりの上限（いずれも余裕あり）

| 項目 | 無料枠 | このアプリ |
| --- | --- | --- |
| サブリクエスト | 50回/リクエスト | 1回（Lambda へ転送のみ） |
| Functions 実行回数 | 10万回/日（UTC 0時リセット） | 数百回/日 |
| リクエストボディ | 100MB | 数KB |
| Worker 起動時間 | 1秒以内 | 中継のみなので問題なし |

ただし **Lambda 側の応答が極端に遅いと、Cloudflare 経由の通信がタイムアウトする**点には注意する。Gemini の生成は再試行を含めても合計30秒程度に収まるよう、`GEMINI_TIMEOUT_MS` と再試行回数を設計する（ステップ6）。

#### 同一オリジンで中継する理由

Cloudflare Access の Cookie がブラウザから自動で送られるようにするため。ブラウザから Lambda を直接呼ぶと、別ドメインなので Cookie が付かない。

## テスト

このステップはインフラ設定のため自動テストは書かない。手動で確認する。

- [ ] `npm run dev` で開発サーバーが動く
- [ ] `npm run build` で `out/` が生成される
- [ ] Cloudflare Pages にデプロイした URL が表示される
- [ ] **未ログインでアクセスするとログイン画面が出る**（カスタムドメイン・本番 `pages.dev`・プレビュー URL の3つすべて）
- [ ] ログイン後、画面が表示される
- [ ] `/api/health` を叩くと Lambda のレスポンスが返る
- [ ] **Lambda から Gemini を呼べる**
- [ ] Lambda のログに `cf-access-jwt-assertion` が届いている
- [ ] **Function URL を直接叩くと 403 になる**（`X-Internal-Api-Key` がないため）
- [ ] 偽造した `cf-access-jwt-assertion` の扱いを**実測して記録した**（除去されなくても可。防御の本体は署名検証）
- [ ] `router.ts` が未定義パスに 404、メソッド違いに 405 を返す（**`X-Internal-Api-Key` を付けた状態で確認する**。付けないと必ず 403 になる）
- [ ] `npm run build` と `npm run lint` が、`lambda/` 作成後も通る（tsconfig / ESLint のスコープ設定が効いている）
- [ ] AWS アカウントが Free Plan か Paid Plan かを確認した

## 完了条件 (DoD)

上記のチェックがすべて通ること。特に **Gemini の疎通**は必須。

## 失敗したときの選択肢

**Gemini が Lambda から呼べなかった場合**（`User location is not supported`）:

1. Lambda のリージョンが本当に東京か確認する
2. それでも駄目なら、Gemini の代わりに Vertex AI（Google Cloud）経由での利用を検討する
3. または OpenAI 等の別 API に切り替える

いずれにせよ**この時点で判明すれば被害は小さい。** これがステップ2を最優先にする理由。

## 注意点

- **AWS の課金に注意。** 無料枠を超えないよう、AWS Budgets で $1 のアラートを設定しておく。Lambda の無料枠自体は恒久だが、**2025-07-15 以降に作った新規アカウントは Free Plan に入り6ヶ月で自動クローズ**される。恒久運用するならアカウント種別を確認し、必要なら Paid Plan に切り替える
- **CORS は本番では不要。** Pages Functions 経由で同一オリジンになるため。開発中にブラウザから直接 Lambda を叩いた場合のみ問題になるが、その叩き方自体を避ける
- **IAM は最小権限にする。** SAM の既定のまま広い権限にしない。Lambda 実行ロールと EventBridge の起動ロールを確認する
- **`.env.example` はコミットする。** ステップ3・9で変数が増えるたびに更新すること
- `AGENTS.md` は `next dev` のたびに自動生成される。差分が出るのは想定内なので、戻さずコミットする
- Lambda のコードは**IDE で書く**。AWS のコンソールでコードを編集しない（Git 管理から外れてしまう）
