# ステップ10: 品質・公開

## 目的

全機能が揃った状態で、入力検証・レート制限・エラー監視を総点検し、公開できる品質にする。

## 前提

- ステップ9まで完了

## 追加・変更するファイル

| パス | 種別 | 役割 |
| --- | --- | --- |
| `lambda/src/lib/rate-limit.ts` | 新規 | レート制限 |
| `lambda/src/lib/logger.ts` | 新規 | 構造化ログ（秘匿情報のマスク込み） |
| `src/app/error.tsx` | 新規 | エラーバウンダリ |
| `src/app/not-found.tsx` | 新規 | 404 ページ |
| `functions/api/[[path]].ts` | 変更 | セキュリティヘッダの付与 |
| `public/_headers` | 新規 | Cloudflare Pages のセキュリティヘッダ |
| `e2e/critical-flows.spec.ts` | 新規 | 主要フローの通し E2E |
| `README.md` | 変更 | 最終確認 |

## 実装方針

### 1. レート制限

**Gemini を呼びうる経路が最優先。** 無料枠を一気に消費されるのを防ぐ。

- 対象: 復習セット取得（フォールバック生成が走る）、単語登録、解答送信、**購読登録**、**設定変更**
- **カウンタの増分は原子的に行う。** 読み取り→比較→書き込みでは同時実行下ですり抜ける（TOCTOU）。`upsert` + `increment` を使う
- ユーザー単位（JWT の email）でカウントする。Cloudflare Access で守られているので、IP 単位より正確
- **保存先はステップ3で作った `RateLimit` テーブル。** Lambda はインスタンス間で状態を共有しない（同時実行が別コンテナに散る）ため、**メモリ上のカウンタは機能しない**
- 上限値は定数に集約する
- 超過時は 429 と再試行可能時刻を返す

Gemini の日次上限（`GEMINI_DAILY_CALL_LIMIT`）はステップ6で先に入れてある。ここではそれを含む本格的な制限に広げる。

なお **Cloudflare Access が前段にあるため、無認証の第三者はそもそも到達できない。** レート制限は「認証済みユーザーの暴走」と「自分の操作ミス」への備えとして入れる。

### 2. 入力検証の総点検

各ステップで Zod を入れてきたが、**横断的に漏れを確認する。**

- [ ] **すべての HTTP ハンドラ**が `getAuthenticatedUser()` を最初に呼んでいる
- [ ] **すべてのバッチハンドラ**（`cron-*.ts`）が Function URL を持たないことを `template.yaml` で確認した
- [ ] `router.ts` が全ルートで `X-Internal-Api-Key` を検証している
- [ ] すべてのハンドラが入力を Zod で検証している
- [ ] 一覧系 API の `limit` に上限がある
- [ ] DB から読んだ JSON（`examples` / `choices` / `questionIds` / `keys`）を検証している
- [ ] Gemini のレスポンスを検証している
- [ ] Push の `endpoint` が許可リストで検証されている
- [ ] すべてのデータ取得が `userId` スコープになっている
- [ ] `Question` の取得が `vocabulary: { userId }` を経由している

### 3. エラー処理とログ

- **秘匿情報をログに出さない**: Gemini の API キー、VAPID 秘密鍵、`DATABASE_URL`、購読の `keys`、**`cf-access-jwt-assertion`（JWT 本体）**、**`X-Internal-Api-Key`**。マスク処理を `logger.ts` に集約する
  - JWT と共有シークレットは**それ自体が認証情報**。ログに残ると、そのまま Lambda 直叩きの手段になる
- UI に返すエラーから内部情報（スタックトレース、DB エラー文）を除く
- サーバー側には調査に足る文脈（userId、操作、タイムスタンプ）を残す
- CloudWatch Logs の保持期間は **30〜90日**に設定する（無期限だと課金が発生し、メールアドレスを長期保持することにもなる）

### 3-2. CI ゲート

**Pages の Git 連携は、対象ブランチへの push が即座に本番デプロイになる。** 検証を通さずに本番が変わる構成なので、歯止めを入れる。

- 本番ブランチを保護し、PR 経由でのみマージする
- CI（GitHub Actions 等）で `npm run lint` / `npm test` / `npm run build` / `npm audit --audit-level=high` を通す
- Lambda 側は `sam deploy` の手動実行なので、フロントだけが自動という非対称を認識しておく

### 4. セキュリティヘッダ

`public/_headers`（Cloudflare Pages の仕組み）で設定する。

- `Content-Security-Policy` — Gemini 生成テキストを表示するため、多層防御として入れる。**静的書き出しでは nonce を発行できない**ため、Next.js のインラインスクリプトに対しては `'unsafe-inline'` かハッシュ指定になる。あわせて `object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'` も入れる
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Content-Type-Options: nosniff`

### 5. セキュリティ最終確認

- [ ] ハードコードされた秘密情報がない（`git log` も含めて確認）
- [ ] **`template.yaml` にシークレットのリテラル値がない**（Secrets Manager / SSM の動的参照のみ）
- [ ] `.env*` がコミットされていない（`.env.example` は最新）
- [ ] **`NEXT_PUBLIC_` が付いているのは VAPID 公開鍵のみ**
- [ ] **ビルド成果物に Lambda の Function URL が含まれていない**（フロントは相対パスのみ）
- [ ] **Function URL を直接叩くと 403 になる**
- [ ] **Access ポリシーが3系統すべてに効いている**（カスタムドメイン、本番 `pages.dev`、プレビュー `*.pages.dev`）
- [ ] `health.ts` に Gemini 呼び出しが残っていない。DB にも触れていない
- [ ] Lambda ランタイムが `nodejs22.x` 以上
- [ ] `ReservedConcurrentExecutions` が設定されている
- [ ] CloudWatch で 401/403 の急増を検知するアラートがある（Function URL への直叩き試行の検知）
- [ ] **ビルド成果物（`out/`）を grep して `GEMINI_API_KEY` の値が含まれていないことを確認**
- [ ] **Lambda の全 HTTP ハンドラが JWT 検証を省略していない**
- [ ] JWT の `aud` と `iss` を検証している
- [ ] 本番の `CF_ACCESS_JWKS_URL` が Cloudflare のドメインを指している
- [ ] Cloudflare Access のポリシーが自分のメールのみ許可している
- [ ] `console.log` などのデバッグ文が残っていない
- [ ] 認証を迂回する開発用フラグが残っていない
- [ ] AWS Budgets のアラートが設定されている

### 6. E2E で主要フローを通す

```
単語を登録 → 問題が用意される → 復習で解答 → 履歴に残る
  → 同日再訪でセットが変わらない
```

### 7. README

**未来の自分が読んで再現できること**が基準。

- セットアップ手順（フロント / Lambda の両方）
- 必要な環境変数の一覧
- ローカル開発の起動方法
- マイグレーション手順
- デプロイ手順（Pages / Lambda）
- VAPID 鍵の生成
- Cloudflare Access の設定
- トラブルシューティング

## テスト

- 全体でカバレッジ 80% を達成していることを確認
- **カバレッジの水増しをしていないか確認する。** 設定ファイルではなく、選択ロジック・日付計算・検証・JWT 検証といった中核が覆われているか
- E2E で主要フローが通る

## 完了条件 (DoD)

- [ ] `npm run lint` が警告なしで通る
- [ ] フロント・Lambda 両方の `npm test` が通り、カバレッジ 80% 以上
- [ ] `npm run test:e2e` の主要フローが通る
- [ ] `npm run build` が通る
- [ ] セキュリティチェックリストが全て埋まっている
- [ ] 本番URLで一連の操作ができる
- [ ] README だけを見て環境を再構築できる

## 注意点

- **レート制限を後回しにしない。** Gemini の無料枠は想定より早く尽きる
- Lambda のバンドルサイズと初回起動（コールドスタート）を確認する。Prisma を含めると数百msかかることがある
- Neon の無料枠はアイドル時に自動停止する。朝の通知後の初回アクセスが遅くなる点を許容できるか確認する
- 監視は最初から凝らなくてよい。CloudWatch でエラー率とバッチの実行結果を見られる状態にする
- 公開後、`doc/implementation-plan.md` の未確定事項（Gemini 無料枠、Lambda 無料枠の恒久性）を実測値で更新する
