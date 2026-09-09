# ステップ7: 解答の仕組みと共通コンポーネント

## 目的

解答 API（正誤判定・履歴記録）と、問題を表示する共通コンポーネントを作る。**学習画面そのものはステップ8で作る。**

## 前提

- ステップ6完了（問題が選定できる）

## ⚠️ 決定事項: 自由学習（`/study`）は作らない

README が謳っているのは「毎日10問の復習」だけで、自由学習は必須機能ではない。作れば復習との干渉設計が必要になる（同じ問題を先に解いてしまうと復習の進捗が汚れる）。**YAGNI により作らない。**

この決定の帰結:

- 出題は復習経路（ステップ8の `handlers/review.ts`）に集約する。ステップ6で `handlers/questions.ts` を作らないのはこのため
- `Attempt.dailySetId` は nullable のまま残すが、**現状は常に非 null**
- **学習（出題）画面は作らない。** 作るのは履歴画面のみ。通しの E2E はステップ8で行う

## 追加・変更するファイル

### Lambda 側

| パス | 種別 | 役割 |
| --- | --- | --- |
| `lambda/src/handlers/answer.ts` | 新規 | 解答送信の API |
| `lambda/src/lib/study/grading.ts` | 新規 | 正誤判定（純粋関数） |
| `lambda/src/repositories/attempt.ts` | 変更 | `createAttempt` を追加 |
| `lambda/src/handlers/history.ts` | 新規 | 学習履歴の取得 |
| `lambda/src/router.ts` | 変更 | `POST /api/answer`、`GET /api/history` を登録 |

### フロント側

| パス | 種別 | 役割 |
| --- | --- | --- |
| `src/lib/api/answer.ts` | 新規 | **解答**送信 API の呼び出し（Lambda 側 `handlers/answer.ts` と対応） |
| `src/components/study/QuestionCard.tsx` | 新規 | 問題と選択肢 |
| `src/components/study/AnswerFeedback.tsx` | 新規 | 正誤と解説 |
| `src/components/study/ProgressIndicator.tsx` | 新規 | 進捗表示 |
| `src/app/history/page.tsx` | 新規 | 学習履歴 |

これらのコンポーネントは**ステップ8の復習画面から再利用する。** 名前を分けて重複させない。

## 実装方針

### 1. 正解をブラウザに送らない（最重要）

静的書き出しの構成では、**画面のデータはすべてブラウザに渡る。** 開発者ツールを開けば中身は丸見えになる。

```
1. 出題 API は prompt と choices のみ返す
   → answer と explanation は含めない
2. ユーザーが選択して解答 API に送信
3. Lambda が DB の answer と突き合わせて判定
4. 判定結果 + 正解 + explanation を返す
```

**出題 API のレスポンスに `answer` を含めた時点で、この機能は意味を失う。** 型の設計で防ぐ（`QuestionForClient` のように、`answer` を持たない型を `shared/types.ts` に定義する）。

### 2. 解答 API の責務

```
submitAnswer(questionId, answer, dailySetId)   ← dailySetId は必須
  1. getAuthenticatedUser() → userId          ← 必須
  2. Zod で入力検証
  3. 問題を userId スコープで取得
  3.5 ★ dailySetId が自分のセットであり、その questionIds に
      questionId が含まれることを確認（不一致なら 403 / 404）
  4. grading.ts で判定
  5. Attempt を作成
  5' 一意制約違反（P2002）を捕捉し、409 と既存の結果を返す
  6. { isCorrect, correctAnswer, explanation } を返す
```

**所有者チェックは2つとも必要。**

`Question` は `userId` を持たないため、`vocabulary: { userId }` を経由して絞る。ここを省くと questionId を推測して他人の問題に解答できる。

**`dailySetId` も同様にチェックする。** これはクライアントから送られる値で、そのまま `Attempt` に保存され、ステップ8の進捗導出の根拠になる。検証しないと:

- 他人の `dailySetId` を指定して `Attempt` を作れる。`@@unique([dailySetId, questionId])` があるため、**他人のセットの問題を先に埋めて解答不能にする妨害**が成立する
- `dailySetId` を省略できると、PostgreSQL の NULL は一意制約で衝突しないため**同じ問題に無制限に再解答**できてしまう

**そのため `dailySetId` は API 契約で必須にする**（Zod で必須指定）。自由学習を作らない方針なので、常に値がある。

### 2-2. 重複解答の扱い

二重送信、戻るボタン、通知タップでの再入場などで同じ `(dailySetId, questionId)` が届きうる。**`P2002` を捕捉しないと 500 になる。**

409 を返し、既存の `Attempt` の結果（`isCorrect` / 正解 / 解説）を返す。`Attempt` は増やさない。

ER 図上、`Attempt` の所有者は「`Attempt.userId`」と「`Attempt.question.vocabulary.userId`」の2経路で決まる。**DB 制約では両者の一致を保証できないため、このチェックがアプリ側の唯一の砦になる。**

### 3. 正誤判定 (`grading.ts`)

純粋関数として切り出す。

**表記ゆれのルールを先に決めてドキュメント化する。** 後から変えると過去の `Attempt` と整合が取れなくなる。

- 前後の空白は無視する
- 大文字小文字は区別しない
- 選択式なので、選択肢の値と完全一致で判定する

### 4. 選択肢の並び順

表示順をランダムにする場合、**インデックスではなく値で送る。** インデックスで送ると、再描画で順序が変わったときにずれる。

### 5. フロントの状態管理

- 「解答前 / 送信中 / 解答済み」の3状態を持つ
- state 更新は必ず新しいオブジェクトを返す
- **送信中は選択肢を無効化する**（二重送信の防止）
- 送信失敗時は再試行の導線を出す。黙って握りつぶさない

### 6. 履歴画面

- `Attempt` を新しい順に表示。**ページネーションを最初から入れる**
- インデックス `Attempt(userId, answeredAt)` を使う
- 単語ごとの正答率を出すと「未定着」の実感につながる

### 7. Gemini 生成テキストの表示

問題文と解説は Gemini が生成したテキスト。**`dangerouslySetInnerHTML` を使わない。** React の自動エスケープに任せ、常にテキストとして描画する。

将来 Markdown 表示を入れたくなったときに、この制約を忘れて脆弱性を作りやすい箇所。

## テスト

**先に書く（RED）:**

- `grading.ts`
  - 完全一致で `true`
  - 不一致で `false`
  - 前後空白の扱い
  - 大文字小文字の扱い
  - 空文字・未選択の扱い
- `handlers/answer.ts`
  - **別 `userId` の問題に解答できない**
  - **別 `userId` の `dailySetId` を指定できない**
  - **`dailySetId` の `questionIds` に含まれない問題を解答できない**
  - JWT なしで 401
  - 存在しない questionId で 404
  - **同一セットの同一問題に2回解答すると 409 が返り、`Attempt` が増えない**
- 出題 API のレスポンス型に `answer` が含まれない（型レベル + 実行時の両方で確認）
- `QuestionCard`
  - 送信中に選択肢が無効化される

**E2E:**

出題画面がないため通しの E2E は書かない（**ステップ8で行う**）。履歴画面のみ E2E で確認する。

**出題取得のクライアントは作らない。** 出題は復習経路（ステップ8の `src/lib/api/review.ts`）に一本化する。2箇所に分散させないこと。

## 完了条件 (DoD)

- [ ] 解答 API が正誤・正解・解説を返す（Lambda の結合テスト）
- [ ] `Attempt` が記録され、履歴画面に表示される
- [ ] **別ユーザーの問題に解答できない**
- [ ] JWT なしで 401、存在しない questionId で 404
- [ ] `QuestionCard` / `AnswerFeedback` / `ProgressIndicator` の単体テストが通る
- [ ] 送信中に選択肢が無効化される（二重送信の防止）
- [ ] カバレッジ 80% 以上

## 注意点

- 表記ゆれのルールを**先に決めて残す**（上記）
- コンポーネントはステップ8の `/review` から使う。同じ役割のものを別名で作り直さない
- ファイルが 200〜400行を超えたら分割する
