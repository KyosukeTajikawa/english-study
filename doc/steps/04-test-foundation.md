# ステップ4: テスト基盤

## 目的

Vitest と Playwright を導入し、以降を TDD で進められる状態にする。カバレッジ 80% 以上を維持する運用を始める。

## 前提

- ステップ3完了（DB と認証がある）

## 追加・変更するファイル

| パス | 種別 | 役割 |
| --- | --- | --- |
| `vitest.config.ts` | 新規 | フロント用（jsdom 環境） |
| `vitest.setup.ts` | 新規 | Testing Library の設定 |
| `lambda/vitest.config.ts` | 新規 | Lambda 用（node 環境） |
| `playwright.config.ts` | 新規 | E2E 設定 |
| `e2e/` | 新規 | E2E テストの置き場 |
| `lambda/src/local-server.ts` | 新規 | ローカル用 HTTP サーバー |
| `lambda/prisma/reset-test-db.ts` | 新規 | E2E 前の DB リセット |
| `lambda/src/lib/__tests__/auth.test.ts` | 新規 | **最初に書くテスト** |
| `package.json` | 変更 | `test` / `test:coverage` / `test:e2e` |
| `lambda/package.json` | 変更 | `test` / `test:coverage` |
| `.gitignore` | 変更 | `/test-results/`、`/playwright-report/`、`/coverage` |

## 依存パッケージ

ルート（フロント用）:

```bash
npm install -D vitest@4.1.11 @vitest/coverage-v8@4.1.11 @vitejs/plugin-react@<固定> jsdom \
  @testing-library/react @testing-library/dom @testing-library/user-event \
  vite-tsconfig-paths @playwright/test
npx playwright install
```

`lambda/`（バックエンド用）:

```bash
npm install -D vitest@4.1.11 @vitest/coverage-v8@4.1.11
```

### ★ バージョンを固定しないと必ず壊れる

| パッケージ | 問題 |
| --- | --- |
| `@vitest/coverage-v8` | peer が `vitest` と**完全一致**を要求する。`latest`（5.0.0）を入れると `vitest@4.1.11` と**必ず衝突**する。`4.1.11` を明示する |
| `@vitejs/plugin-react` | 最新（6.x）は peer が `vite ^8.0.0`。vitest 4.1.11 の peer は `vite ^6 \|\| ^7 \|\| ^8` なので、組み合わせ次第で解決不能になる。バージョンを固定する |

**Node.js は 22.12 以上を使う。** `@vitejs/plugin-react` の `engines` が `^20.19.0 || >=22.12.0` のため、Next 16 の要件である 20.9.0 では足りない。

## 実装方針

### 1. テスト環境が2つに分かれる

この構成ではフロントと Lambda が別プロジェクトなので、Vitest の設定も2つ必要になる。

| | 環境 | 対象 |
| --- | --- | --- |
| ルートの `vitest.config.ts` | `jsdom` | React コンポーネント、API クライアント |
| `lambda/vitest.config.ts` | `node` | 出題選択、日付計算、Gemini 連携、JWT 検証 |

**ロジックの大半は Lambda 側にある。** カバレッジの重心もそちらに置く。

### 2. テスト戦略の切り分け

| 対象 | 手法 | 理由 |
| --- | --- | --- |
| 出題選択、優先度計算、日付/TZ計算 | Vitest（Lambda 側・純粋関数） | 最も壊れやすくテスト価値が高い |
| JWT 検証 | Vitest（Lambda 側） | 認証の要。鍵はテスト用に生成する |
| Zod スキーマ | Vitest（両側） | 境界値を網羅しやすい |
| Gemini のレスポンス処理 | Vitest（API はモック） | 不正 JSON を再現する |
| リポジトリ層 | Vitest（**Prisma Client を注入**） | 後述 |
| React コンポーネント | Vitest + Testing Library | 静的書き出しなので全てクライアントコンポーネント |
| 主要ユーザーフロー | Playwright | — |

### 3. リポジトリ層のテスト方針（重要）

`userId` スコープが守られていることは**必ずテストで示す**。これが認証まわりの唯一の安全網になる。

そのために、リポジトリ関数は **Prisma Client を引数で受け取る**形にする。

```
listVocabularies(db, userId)      ← db を注入する
```

こうすると軽量なフェイクを渡せて、`where` 句に `userId` が入っているかを検証できる。実 DB もコンテナも不要。

**これはステップ5以降のリポジトリ設計を縛るので、ここで決めておく。**

### 4. React コンポーネントのテスト

本プロジェクトは**設計判断として**データ取得を全て Lambda に寄せるため、画面はすべてクライアントコンポーネントになる（静的書き出しの制約ではなく方針）。結果として async Server Component が存在しないので、Vitest がそれを扱えない問題は起きない。

データ取得は API クライアント経由なので、`fetch` をモックすればコンポーネント単体でテストできる。

### 5. カバレッジ

- provider は `v8`、しきい値 80% を設定して**下回ったら失敗させる**
- 除外: `out/`、`.next/`、`e2e/`、設定ファイル、`lambda/prisma/`、`lambda/src/lib/db.ts`（DB 接続の生成のみ）、`lambda/src/local-server.ts`、`lambda/src/handlers/health.ts`（疎通用）
- **設定ファイルや型定義でカバレッジを水増ししない。** ロジックの中心（出題選択・日付計算・検証）を確実に覆う

### 6. 最初のテスト

TDD の題材として `lambda/src/lib/auth.ts` を選ぶ。

書くべきケース:

- 有効な JWT で `userId` と `email` が返る
- 署名が不正なら例外
- 有効期限切れなら例外
- `aud` が異なれば例外
- ヘッダが欠落していれば例外
- 同じ email で2回呼んでも `User` が重複しない

### 7. ★ ローカル実行モデル（先に確定させる）

**素直に組むと、ローカルでは API が1本も通りません。** 理由が3つあるので、それぞれ対処を決めておく。

| 問題 | 対処 |
| --- | --- |
| `next dev` は `functions/api/[[path]].ts` を実行しない。同一オリジンの `/api/*` が解決されない | **`npx wrangler pages dev out/`** で Pages Functions ごと起動する。本番と同じ経路になる |
| `sam local start-lambda` は **Invoke API** の模擬であって HTTP サーバーではない。`fetch("/api/...")` は通らない | `lambda/src/local-server.ts` を用意し、`router.ts` を Node の HTTP サーバーで包む。Function URL のイベント形状に変換するだけ |

> ⚠️ **`local-server.ts` を `node` で直接実行できない。** Lambda 側の import は ESM 規約に従って `.js` 拡張子を付けており（`./router.js`）、Node の型ストリップ（`--experimental-strip-types`）はこれを `.ts` に解決しない。**esbuild でバンドルしてから実行する**か `tsx` を使うこと。ステップ2で実測して確認済み。
| ローカルには Cloudflare Access の JWT がない。全ハンドラが 401 になる | **`CF_ACCESS_JWKS_URL` をテスト用鍵に差し替える**（ステップ3） |

**認証を迂回するフラグは作らない。** 検証ロジックを本番と同一に保ったまま、信頼する鍵だけを差し替える。

#### ★ JWT の署名処理を本番バンドルに入れない

ローカル用の JWT をどこで作るかが**新たな認証バイパスの温床になる。**

`functions/api/[[path]].ts`（本番でもデプロイされる唯一の中継ファイル）に「ローカルなら自己署名する」という分岐を入れると、**環境変数の設定ミス1つで「任意のユーザーの JWT を中継が自己署名して Lambda に渡す」経路**になる。しかも Lambda 側の検証は防波堤にならない（ローカル用 JWKS がその鍵を正当と判定するため）。Lambda から排除したはずのパターンを、中継側に再導入することになる。

**対策: Pages Functions に環境分岐を持たせない。**

```
1. 手元スクリプト（lambda/scripts/gen-test-keys.ts）でテスト鍵ペアと
   固定の JWT を生成する
2. その JWT を .dev.vars に置く
3. ローカルの Pages Functions は「.dev.vars の値をヘッダに付けて転送する」だけ
   （本番と同じコード。値の出どころが違うだけ）
4. local-server.ts がテスト用 JWKS を配信し、Lambda が本番と同じロジックで検証する
```

これなら中継に署名ロジックが一切入らない。

追加ファイル:

| パス | 役割 |
| --- | --- |
| `lambda/src/local-server.ts` | ローカル用 HTTP サーバー + テスト用 JWKS の配信 |
| `lambda/scripts/gen-test-keys.ts` | テスト鍵ペアと固定 JWT の生成 |
| `lambda/prisma/reset-test-db.ts` | E2E 前の DB リセット |
| `.dev.vars.example` | `LAMBDA_FUNCTION_URL`、`INTERNAL_API_KEY`、テスト用 JWT |
| `lambda/package.json` | `local` スクリプトを追加 |
| `.gitignore` | **`.dev.vars` を追加**（`.env*` のパターンでは拾えない） |

### 8. テスト用データベース

**本番と同じ DB を E2E でリセットすると事故になる。** Neon の**ブランチ機能**でテスト用 DB を分け、`DATABASE_URL_TEST` として持つ。

E2E 実行前に必ずリセットしてシードし直す。特にステップ8の「同日に同じセットが返る」は、前日の `DailySet` が残っていると結果が変わる。

### 8-2. ★ 開発ループ（ホットリロードをどう確保するか）

**`wrangler pages dev out/` はビルド済みの `out/` を配信する。** UI を1行直すたびに `npm run build` が必要になり、ステップ5〜9のフロント開発が非常に遅くなる。

用途で使い分ける。

| 用途 | 方法 |
| --- | --- |
| **UI の作り込み** | `next dev` + `next.config.ts` の `rewrites` で `/api/:path*` を `local-server` に転送。ホットリロードが効く |
| **本番同等の確認・E2E** | `npm run build && npx wrangler pages dev out/` |

> `output: "export"` 下で `rewrites` がビルドに効かないのは想定どおり（静的書き出しには含まれない）。**dev サーバーでは効く**が、この挙動はステップ4で実測して確認すること。効かなければ UI 開発も `wrangler pages dev` に統一する。

この方式では `next dev` 経由で Pages Functions を通らないため、**中継経路そのものの確認は必ず `wrangler pages dev` 側で行う。**

### 9. Playwright

- `webServer` の `command` は **`npm run build && npx wrangler pages dev out/`**。ビルドを挟まないと古い `out/` でテストが走り、原因不明の失敗になる
- フロントは常に相対パス `/api/...` を叩くので、環境変数の切り替えは不要
- 現時点では画面がないので、設定と疎通用の1本だけ用意する

## テスト

このステップの成果物がテストそのもの。

## 完了条件 (DoD)

- [ ] `npm test`（フロント）が通る
- [ ] `cd lambda && npm test` が通る
- [ ] 両方でカバレッジのしきい値判定が働く
- [ ] **`wrangler pages dev` で起動し、ブラウザから `/api/health` が通る**（本番と同じ中継経路）
- [ ] **ローカルのテスト用鍵で署名した JWT が検証を通り、不正な鍵では 401 になる**
- [ ] `npm run test:e2e` が最低1本通る
- [ ] テスト用 DB が本番と分かれており、リセットが流せる
- [ ] `auth.test.ts` が RED → GREEN の順で書かれている

## 注意点

- **vitest は 4.1.11 に固定する**（上記）
- Playwright のブラウザバイナリは `npx playwright install` が必要。CI を組むときに忘れやすい
- E2E のデータ隔離を最初に決めておく。特にステップ8の「同じセットが返る」テストは、前日のデータが残っていると結果が変わる
- 以降のステップでは**必ずテストを先に書く**。実装してから足す順序にしない
