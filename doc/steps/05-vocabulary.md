# ステップ5: 単語帳

## 目的

単語・イディオム、意味、コアイメージ、例文、出典の登録・編集・削除・一覧を実装する。ここが全機能の入力元になる。

**この構成で初めてフロントと Lambda を通しで作るステップ**でもある。以降の画面はここで作った型を踏襲する。

## 前提

- ステップ3（DB・認証）、ステップ4（テスト基盤）完了

## 追加・変更するファイル

### Lambda 側

| パス | 種別 | 役割 |
| --- | --- | --- |
| `lambda/src/handlers/vocabulary.ts` | 新規 | API のエントリポイント |
| `lambda/src/repositories/vocabulary.ts` | 新規 | DB アクセス。**必ず userId スコープ** |
| `shared/schemas/vocabulary.ts` | 新規 | **Zod スキーマ**（フロントのフォーム検証と共用） |
| `lambda/src/lib/response.ts` | 新規 | レスポンス形式の共通化 |
| `lambda/src/router.ts` | 変更 | **ルートを登録**（`template.yaml` ではない） |

### フロント側

| パス | 種別 | 役割 |
| --- | --- | --- |
| `src/lib/api-client.ts` | 新規 | `fetch` のラッパー。エラー処理を共通化 |
| `src/lib/api/vocabulary.ts` | 新規 | 単語帳 API の呼び出し |
| `src/app/vocabulary/page.tsx` | 新規 | 一覧画面 |
| `src/app/vocabulary/new/page.tsx` | 新規 | 新規登録 |
| `src/app/vocabulary/edit/page.tsx` | 新規 | 編集（`?id=xxx`） |
| `src/components/vocabulary/VocabularyForm.tsx` | 新規 | 入力フォーム |
| `src/components/vocabulary/VocabularyList.tsx` | 新規 | 一覧表示 |
| `src/components/layout/AppNav.tsx` | 新規 | **画面間のナビゲーション** |
| `src/app/layout.tsx` | 変更 | ナビゲーションを組み込む |
| `src/app/page.tsx` | 変更 | スターターページを差し替え |
| `shared/types.ts` | 変更 | 単語帳の型を追加 |

最終的な画面は `/`、`/vocabulary`、`/vocabulary/new`、`/vocabulary/edit`、`/history`、`/review`、`/settings` の7つになる。**ナビゲーションをここで作っておかないと、ステップ10の通し E2E（登録 → 復習 → 履歴）が書けない。** 以降のステップで画面が増えるたびにリンクを追加する。

## 依存パッケージ

`zod` はステップ3で導入済み（フロントと Lambda で同一バージョン）。このステップでの追加はない。

## 実装方針

### 1. API の設計

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/vocabulary` | 一覧（ページネーション付き） |
| GET | `/api/vocabulary/:id` | 1件取得 |
| POST | `/api/vocabulary` | 作成 |
| PUT | `/api/vocabulary/:id` | 更新 |
| DELETE | `/api/vocabulary/:id` | 論理削除 |

レスポンスは共通の形にする。

```
成功: { ok: true,  data: ... }
失敗: { ok: false, error: { message, fields? } }
```

`lambda/src/lib/response.ts` に集約し、全ハンドラで使う。

### 2. すべての HTTP ハンドラの共通の型

```
0. X-Internal-Api-Key の検証               ← router.ts で一括。不一致なら 403
1. getAuthenticatedUser(event) → userId    ← 必ず最初。失敗なら 401
2. Zod で入力検証                          ← 失敗なら 400 + フィールド別エラー
3. リポジトリ呼び出し（userId を渡す）
4. レスポンスを返す
```

**Lambda の URL は公開されている。** 1 を省いたハンドラを1つでも作ると、そこが穴になる。0 は `router.ts` で全ルート共通に掛ける。

### 3. Zod スキーマ

| フィールド | ルール |
| --- | --- |
| `word` | 必須、1〜100文字、前後空白をトリム |
| `wordType` | `"word"` \| `"idiom"` |
| `meaning` | 必須、1〜500文字 |
| `coreImage` | 任意、0〜500文字 |
| `examples` | 文字列配列、0〜5件、各1〜300文字 |
| `source` | 任意、0〜200文字。どこで見聞きしたか |

`coreImage` と `source` は**空文字をトリム後に `null` へ正規化する**。DB に `""` と `null` が混在すると絞り込み条件が二重になる。

型は `z.infer` で導出し、**型定義を二重に書かない。**

### 4. リポジトリ層

ステップ4で決めたとおり、**Prisma Client を引数で受け取る。**

```
listVocabularies(db, userId, { limit, offset })
getVocabulary(db, userId, id)
createVocabulary(db, userId, input)
updateVocabulary(db, userId, id, input)
deleteVocabulary(db, userId, id)     ← 論理削除
```

- **すべての関数が `userId` を取る。** `getVocabulary(db, id)` のように ID だけで引く実装にしない
- 取得系は必ず `deletedAt: null` を条件に含める
- 更新・削除は `updateMany({ where: { id, userId, deletedAt: null } })` を使い、**更新件数0なら「見つからない」として 404 を返す**。先に取得してから更新する二段構えにしない
- 削除は `deletedAt` に現在時刻を入れるだけ（物理削除しない）
- **`updateVocabulary` は `generationFailCount` を 0、`lastGenerationAttemptAt` を `null` にリセットする。** 単語の内容を直したのに生成が再試行されないと、その単語は永久に問題0件のままになる（ステップ9参照）

### 5. ページネーション

一覧は最初から `limit` / `offset` を入れる。並び順は `createdAt` の降順。

**`createdAt` がないと安定した並び順にならない。** ステップ3でカラムを入れてあるので必ず使う。

**`limit` には上限を設ける**（例: 最大100）。Zod スキーマで縛らないと、大きな値を渡されて不要に重いクエリになる。

### 6. API クライアント (`src/lib/api-client.ts`)

- ベースパスは相対の `/api`。**Function URL を埋め込まない**（ステップ2参照）
- エラーレスポンスは例外ではなく戻り値として扱えるようにする

#### ★ Access のセッション切れを扱う

セッションが切れた状態で `/api/*` を叩くと、Cloudflare Access は **ログインページへのリダイレクト（HTML）** を返す。これを JSON としてパースすると例外になり、画面には「不明なエラー」が出て復帰できなくなる。

**Access の既定セッションは有限（数時間〜24時間）で、毎朝の通知からアクセスする使い方ではセッション切れが日常動作になる。** 特に通知タップで `/review` を開く経路で必ず起きる。

対処: レスポンスが JSON でない、または Access のリダイレクトを検出したら `window.location.reload()` でログインフローに乗せる。

### 7. フロント側

静的書き出しなので**すべてクライアントコンポーネント**（`"use client"`）。

- データ取得は `useEffect` + `fetch`、またはシンプルな自作フックで行う
- **読み込み中・エラー・空の3状態を必ず作る。** 特に「まだ単語がありません」は最初に必ず見る画面なので、登録への導線を置く
- フォームの state 更新は不変に行う（`[...examples, newOne]` / `examples.filter(...)`）。`push` / `splice` を使わない
- 二重送信を防ぐため、送信中はボタンを無効化する

### 8. 編集画面のルーティング

静的書き出しでは `/vocabulary/[id]` のような動的ルートに `generateStaticParams` が必要で、ID が事前に分からないため使えない。

**`/vocabulary/edit?id=xxx` のクエリパラメータ方式にする。** `useSearchParams` で ID を取得する。

#### ★ `useSearchParams` は Suspense で囲まないとビルドが落ちる

公式ドキュメントに明記がある。

> During production builds, a static page that calls `useSearchParams` from a Client Component **must be wrapped in a `Suspense` boundary, otherwise the build fails**.
> In development, routes are rendered on-demand, so `useSearchParams` doesn't suspend and things may appear to work without `Suspense`.

**`npm run dev` では動くのに `npm run build` で落ちる**典型パターン。

対策: `page.tsx` を薄いラッパにし、実体を別コンポーネントに切り出す。

```
page.tsx            → <Suspense fallback={...}><EditVocabularyClient /></Suspense>
EditVocabularyClient.tsx → useSearchParams を使う実体
```

設定画面（ステップ9）など、以降でクエリパラメータを使う画面でも同じ対応が必要。

## テスト

**先に書く（RED）:**

- `validation/vocabulary.ts`
  - 境界値（0文字、上限、上限+1、空白のみ、例文6件）
  - `wordType` の不正値
  - `coreImage` / `source` の空文字が `null` に正規化される
- `repositories/vocabulary.ts`（**最重要**）
  - 別 `userId` のデータを取得・更新・削除できない
  - `deletedAt` が入った行が一覧に出ない
  - 更新件数0のとき「見つからない」を返す
  - **更新時に `generationFailCount` が 0 にリセットされる**
- `handlers/vocabulary.ts`
  - JWT がなければ 401
  - 不正な入力で 400 とフィールド別エラー
- `api-client.ts`
  - エラーレスポンスが例外ではなく結果として扱える
  - **非 JSON レスポンス（Access のリダイレクト）で例外を投げず、既定の復帰動作をとる**
- `limit` の上限超過が Zod で弾かれる

**E2E:**

- 登録 → 一覧に表示される
- 編集 → 反映される
- 削除 → 一覧から消える
- 単語0件で案内が表示される

## 完了条件 (DoD)

- [ ] 登録・編集・削除・一覧が動く
- [ ] 不正入力でフィールド別のエラーが表示される
- [ ] **別 `userId` のデータに一切アクセスできないことがテストで示されている**
- [ ] JWT なしのリクエストが 401 になる
- [ ] 削除が論理削除であり、履歴が消えない
- [ ] カバレッジ 80% 以上

## 注意点

- **`src/app/page.tsx` はまだスターターのまま。** このステップで差し替える
- JSON カラム（`examples`）は PostgreSQL のネイティブ JSON なので文字列詰め込みは不要。ただし **DB から読んだ値も Zod で検証する**。壊れた行でアプリ全体が落ちないようにする
- `source` はステップ6で Gemini に渡すか検討するが、初期は渡さない
- ファイルは 200〜400行を目安に分割する。フォームが肥大化したら入力欄を切り出す
