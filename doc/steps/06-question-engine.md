# ステップ6: 出題エンジン

## 目的

Gemini API で問題を生成し、保存して再利用する。出題時は保存済み問題から選び、一度出した問題はしばらく再出題しない。

このプロジェクトで**最も複雑で最も壊れやすい**部分。ロジックを純粋関数として切り出し、テストで固める。

## 前提

- ステップ5完了（単語が登録できる）
- ステップ2で **Lambda から Gemini を呼べることが確認済み**

## ⚠️ 着手前に確定すること

**出題形式（`Question.format`）の一覧を決める。** これが決まらないとスキーマもバリデーションも書けない。

初期は**選択式のみ**を推奨する（KISS）。

| 形式 | 内容 |
| --- | --- |
| `meaning-to-word` | 意味から英単語を4択 |
| `word-to-meaning` | 英単語から意味を4択 |
| `fill-in-blank` | 例文の穴埋め4択 |

全形式が選択式なら、`answer` が `choices` に含まれているかを一律に検証できる。記述式を混ぜる場合は `choices` を nullable にし、検証を形式ごとに分岐させる必要がある。

## 追加・変更するファイル

すべて Lambda 側。フロントは次のステップ。

| パス | 種別 | 役割 |
| --- | --- | --- |
| `lambda/src/lib/gemini/client.ts` | 新規 | Gemini クライアント |
| `lambda/src/lib/gemini/prompt.ts` | 新規 | プロンプト組み立て（純粋関数） |
| `lambda/src/lib/gemini/schema.ts` | 新規 | 生成結果の Zod スキーマ |
| `lambda/src/lib/gemini/generate.ts` | 新規 | 生成 + 再試行 + フォールバック |
| `lambda/src/lib/questions/formats.ts` | 新規 | 出題形式の定義 |
| `lambda/src/lib/questions/selection.ts` | 新規 | **出題選択（純粋関数・最重要）** |
| `lambda/src/lib/constants.ts` | 新規 | 定数を集約 |
| `lambda/src/repositories/question.ts` | 新規 | Question の永続化 |
| `lambda/src/repositories/attempt.ts` | 新規 | Attempt の集計取得 |
| `lambda/src/lib/gemini/budget.ts` | 新規 | Gemini 呼び出しの日次上限（簡易サーキットブレーカー） |

**出題取得の API はこのステップでは作らない。** 自由学習画面を作らない方針のため、出題は復習経路（ステップ8の `handlers/review.ts`）に集約する。ここで `handlers/questions.ts` を作ると誰にも呼ばれない死んだコードになる。

## 依存パッケージ

ステップ2で `@google/genai` を導入済み。

## 実装方針

### 1. 定数を1箇所に集める

`lambda/src/lib/constants.ts` にすべて置く。マジックナンバーを散らさない。

| 定数 | 意味 | 初期値 |
| --- | --- | --- |
| `MIN_REPEAT_INTERVAL_DAYS` | 同じ問題を再出題しない日数 | 7 |
| `TARGET_QUESTIONS_PER_VOCABULARY` | 1単語あたり溜めたい問題数 | 10 |
| `MAX_QUESTIONS_PER_VOCABULARY_PER_SET` | 1セット内の同一単語の上限 | 3 |
| `MASTERY_CORRECT_COUNT` | **定着とみなす正解回数** | 3 |
| `GEMINI_MAX_RETRIES` | 生成の再試行回数 | 3 |
| `GEMINI_TIMEOUT_MS` | 1回の生成のタイムアウト | 10000 |
| `GEMINI_TOTAL_BUDGET_MS` | 再試行を含む合計の上限 | 30000 |
| `GEMINI_DAILY_CALL_LIMIT` | 1日あたりの Gemini 呼び出し上限（ユーザー単位） | 50 |
| `GEMINI_GLOBAL_DAILY_LIMIT` | **同（アプリ全体）** | 200 |
| `MAX_GENERATION_FAILURES` | この回数失敗した単語は生成対象から外す | 3 |
| `DAILY_QUESTION_COUNT` | 復習の出題数 | 10 |

`MASTERY_CORRECT_COUNT` は優先度3「未定着」の判定基準。これがないと `selection.ts` にマジックナンバーが埋まる。

### 1-2. ★ Gemini の簡易サーキットブレーカー

本格的なレート制限はステップ10だが、**Gemini を呼ぶ経路はこのステップで動き出す。** 無防備なまま4ステップ分の開発期間を過ごすと、フロントのポーリングのバグや誤操作で無料枠を一気に使い切る。

`budget.ts` に最小限の歯止めを入れる。

**上限は2種類必要。**

| バケット | 単位 | 理由 |
| --- | --- | --- |
| `gemini:user:<userId>` | ユーザーごと | 1ユーザーの暴走を防ぐ |
| **`gemini:global`** | **アプリ全体** | **Gemini の無料枠は API キー単位の共有リソース。** ユーザー単位だけだと 50ユーザー × 上限 で枠を突破する |

`RateLimit` の一意キーは `[userId, bucket, windowStart]` なので、グローバル用は `userId` にセンチネル値（`"__global__"`）を入れて表現する。

- `GEMINI_DAILY_CALL_LIMIT`（ユーザー単位）と `GEMINI_GLOBAL_DAILY_LIMIT`（全体）の両方を超えたら生成しない
- **カウンタの増分は原子的に行う。** 読み取り→比較→書き込みでは同時実行ですり抜ける。`upsert` + `increment`（`ON CONFLICT DO UPDATE SET count = count + 1`）を使う
- 超過は**エラーにせず**フォールバック扱いにする（画面を壊さない）
- **`budget.ts` は HTTP 経路と夜間バッチ経路の両方を通す。** バッチ側だけ素通しにすると全体上限の意味がなくなる

### 2. 出題選択ロジック（設計の要）

**DB アクセスと選択ロジックを混ぜない。** 引数も戻り値も素のデータにする。

```
selectQuestions({
  candidates,       // 出題可能な問題（vocabularyId, format を含む）
  recentlyServed,   // 間隔条件で除外された問題の { id, format, lastServedAt }
  attemptStats,     // 候補に限定した集計（questionId ごとの正解数・誤答数・最終解答日）
  count,
  random,           // 乱数を注入する
}) → Question[]
```

**`recentlyServed` を渡す理由**: 「直近で使っていない出題形式を優先」を判定するには、直近に何を出したかを知る必要がある。しかし `candidates` は間隔条件で除外した後の集合なので、除外された情報がないと形式の偏りを判定できない。除外処理の副産物なので追加クエリは不要。

**`attemptStats` を集計済みで渡す理由**: `Attempt` は毎日増え続ける。全件をロードすると1年で数千件になる。候補に限定した集計を DB 側で行う。

優先度（高い順）:

1. **未出題** — `lastServedAt` が `null`
2. **直近で誤答** — 最後の解答が不正解
3. **未定着** — 正解回数が少ない
4. **最終出題からの経過が長い**

同一優先度内はランダム。加えて:

- **出題形式が偏らないようにする**（`recentlyServed` の形式を避ける）
- **同一単語は1セットに `MAX_QUESTIONS_PER_VOCABULARY_PER_SET` 問まで。** これがないと、単語を1件しか登録していないときに同じ単語の問題が10問並ぶ
- 正解回数が `MASTERY_CORRECT_COUNT` 以上の問題は「定着済み」として後回しにする

### 3. 再出題の間隔制御

```
候補 = lastServedAt が null
     または lastServedAt < 今日 - MIN_REPEAT_INTERVAL_DAYS
```

**除外した結果0件になったら段階的に条件を緩める。** 「新鮮な問題がないので出題できません」は最悪の挙動。

1. 間隔条件を満たす問題
2. 満たさないが未正解の問題
3. すべての問題（間隔条件を無視）

出題が確定した時点で `lastServedAt` を更新する。**解答時ではなく出題時。** 解かずに離脱した問題も「出した」扱いにする。

### 4. 生成コストを抑える

```
出題リクエスト
  → 保存済み Question から候補を集める
  → 足りる  → 生成せずに返す（Gemini を呼ばない）  ← 通常
  → 足りない → 不足分だけ生成                      ← フォールバック
```

**生成の主役は夜間バッチ（ステップ9）。** リクエスト中の生成はフォールバックに留める。

生成処理は**出題フローから独立した関数**にする。

```
generateQuestionsForVocabulary(vocabulary, existingQuestions, count)
```

これを出題時のフォールバックと夜間バッチの両方から呼ぶ（DRY）。

### 5. 構造化 JSON と検証

Gemini には JSON スキーマを指定した構造化出力を要求する。ただし **モデルは指示に反した出力を返しうる前提で組む。**

```
1. Gemini 呼び出し
2. JSON.parse
3. Zod で検証            ← 必ず通す
4. 既存問題との重複チェック
失敗 → 再試行（最大 GEMINI_MAX_RETRIES 回、指数バックオフ）
全失敗 → フォールバック（例外を投げない）
```

- **`answer` が `choices` に含まれているかを `refine` で検証する。** モデルはここを間違える
- 選択肢の重複、選択肢数の不足も検証する
- 生成に失敗しても画面を壊さない。保存済み問題で埋める → それも無ければ正常に「問題を用意できませんでした」と返す

プロンプトに渡すもの:

- 単語、意味、コアイメージ、例文
- **既存問題の要約**（重複回避。全文ではなく `prompt` の先頭のみでトークン節約）
- 生成してほしい出題形式

`Vocabulary.source` は**初期実装では渡さない**。表記が揺れる自由記述で、生成品質への寄与が未検証のため。

### 6. 実行時間の設計

Lambda のデフォルトタイムアウトは3秒。**Gemini を呼ぶ関数は 30〜60秒に延ばす**（`template.yaml`）。夜間バッチはさらに長くてよい。

ただし**ブラウザからのリクエスト経路には合計時間の予算を設ける。**

```
ブラウザ → Cloudflare Pages Functions → Lambda → Gemini
```

`fetch()` の待ち時間は Cloudflare の CPU 時間には算入されないが、**応答が極端に遅いと経路のどこかでタイムアウトする。** 再試行を含めた合計が `GEMINI_TOTAL_BUDGET_MS`（30秒）を超えたら、それ以上粘らずフォールバックへ倒す。

1回のタイムアウトを10秒、再試行3回としても、**合計予算で打ち切る**ので30秒を超えない。個々のタイムアウト値だけを決めて合計を見ないと、最悪ケースで想定の3倍待つことになる。

なお夜間バッチはブラウザが待っていないため、この予算に縛られない。**時間のかかる生成はバッチに寄せる**のが基本方針（上記4）。

### 7. 開発中のプール

ステップ6〜8の開発中は `Question` が0件から始まり、必ずフォールバック生成が走る。Gemini の無料枠を開発で消費してしまう。

**シードにダミーの `Question` を投入して、プールがある状態を作る。** 生成を呼ばない主経路を先に完成させられる。

## テスト

**先に書く（RED）:**

`selection.ts`（最重要、ここを厚く）

- 未出題が最優先
- 誤答した問題が正答済みより優先
- 候補が要求数より少ない場合に全件返る
- 候補0件でも例外を投げず空配列
- 乱数を注入して決定的に検証
- **`lastServedAt` が間隔以内の問題が除外される**
- **除外で0件になったら段階的に緩和される**
- **出題形式が偏らない**（`recentlyServed` を使う）
- **同一単語が `MAX_QUESTIONS_PER_VOCABULARY_PER_SET` を超えない**
- **定着済み（正解 `MASTERY_CORRECT_COUNT` 回以上）の問題が未定着より後回しになる**

`gemini/`（API はモック。**実際の Gemini を呼ぶテストは書かない**）

- 正常な JSON → 問題が返る
- 不正な JSON → 再試行
- 全失敗 → フォールバック（例外を投げない）
- `answer` が `choices` にない → 弾かれる
- 選択肢が重複 → 弾かれる
- 既存問題と重複 → 再生成

`prompt.ts`

- コアイメージが空でも成立する

## 完了条件 (DoD)

- [ ] 出題形式が確定し `formats.ts` に定義されている
- [ ] 保存済み問題で足りる場合に Gemini が呼ばれないことがテストで示されている
- [ ] 不正 JSON・重複・API エラーでアプリが落ちない
- [ ] `selectQuestions` の分岐が網羅されている
- [ ] Gemini のキーが Lambda の外に出ていない
- [ ] **日次上限を超えたら生成を止め、保存済み問題で応答する**
- [ ] カバレッジ 80% 以上

## 注意点

- **Gemini の無料枠を着手時に確認する。** モデル名と1日あたりの上限はプランにより変わる。モデル名は定数に集約する
- 生成した問題には必ず `generatedAt` を記録する
- Gemini 連携（外部依存・モック対象）と選択ロジック（純粋・テスト対象）を1ファイルに混ぜない
- 出題 API のレスポンスに **`answer` と `explanation` を含めない**（ステップ7で詳述）
