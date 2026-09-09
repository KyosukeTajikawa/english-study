# ステップ9: 定期実行（通知 + 問題の事前生成）

## 目的

EventBridge Scheduler から Lambda を定期実行し、2つのバッチを動かす。

1. **復習通知** — 毎日 06:00（Asia/Tokyo）に Web Push でリマインド
2. **問題の事前生成** — 夜間に Gemini で問題を作り足し、出題プールを育てる

2つ目が「毎回違う問題を出したい」という要件を支える。生成をユーザーの待ち時間から切り離すことで、出題時は保存済み問題を返すだけで済む。

## 前提

- ステップ8完了
- 本番が HTTPS で公開されている（Web Push の必須要件）

## この構成の利点

Cloudflare Workers 案で懸念していた問題が**すべて消えている。**

| 懸念だったこと | この構成では |
| --- | --- |
| `web-push` が Workers で動くか不明 | **Lambda は素の Node.js。そのまま動く** |
| VAPID 署名を WebCrypto で再実装する可能性 | 不要 |
| Cron が `scheduled` ハンドラを呼ぶ設計が必要 | EventBridge が直接 Lambda を呼ぶ |
| Cron エンドポイントが公開 URL で誰でも叩ける | **公開 URL を作らない**（EventBridge から直接呼ぶ） |
| Workers の CPU 10ms 制限 | Lambda は最大15分 |

## 追加・変更するファイル

### Lambda 側

| パス | 種別 | 役割 |
| --- | --- | --- |
| `lambda/src/handlers/cron-notify.ts` | 新規 | **バッチハンドラ**（EventBridge のみ。Function URL を持たない） |
| `lambda/src/handlers/cron-generate.ts` | 新規 | **バッチハンドラ**（同上） |
| `lambda/src/handlers/subscription.ts` | 新規 | 購読の登録・解除 API（HTTP ハンドラ） |
| `lambda/src/handlers/settings.ts` | 新規 | 通知設定の更新 API（HTTP ハンドラ） |
| `lambda/src/router.ts` | 変更 | 購読・設定のルートを登録 |
| `lambda/src/lib/push/send.ts` | 新規 | 通知送信 |
| `lambda/src/lib/notifications/schedule.ts` | 新規 | **送信対象の判定（純粋関数）** |
| `lambda/src/lib/generation/find-vocabularies-to-fill.ts` | 新規 | **生成対象の選定（純粋関数）** |
| `lambda/src/lib/validation/subscription.ts` | 新規 | 購読情報の検証 |
| `lambda/src/repositories/push-subscription.ts` | 新規 | 購読の永続化 |
| `lambda/src/lib/constants.ts` | 変更 | バッチ用の定数を追記 |
| `lambda/template.yaml` | 変更 | 2つのスケジュールを追加 |

### フロント側

| パス | 種別 | 役割 |
| --- | --- | --- |
| `public/sw.js` | 新規 | Service Worker |
| `public/manifest.webmanifest` | 新規 | Web App Manifest（`app/manifest.ts` ではなく `public/` に置く。静的書き出しでの出力挙動を検証せずに済む） |
| `public/icon-192.png` / `icon-512.png` | 新規 | **PWA アイコン（必須）** |
| `public/apple-touch-icon.png` | 新規 | iOS ホーム画面用 |
| `src/components/push/PushSubscriptionManager.tsx` | 新規 | 購読 UI |
| `src/lib/push/base64.ts` | 新規 | `urlBase64ToUint8Array`（純粋関数） |
| `src/app/settings/page.tsx` | 新規 | 通知設定画面 |

## 依存パッケージ

`lambda/` で:

```bash
npm install web-push
npm install -D @types/web-push
```

`web-push@3.6.7` / `@types/web-push@3.6.4`。

## 実装方針

### 1. VAPID 鍵

```bash
npx web-push generate-vapid-keys
```

| 環境変数 | 公開範囲 | 置き場所 |
| --- | --- | --- |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | 公開してよい | `.env.local` / Pages の環境変数 |
| `VAPID_PRIVATE_KEY` | **絶対に公開しない** | `lambda/.env` / Lambda の環境変数 |

`NEXT_PUBLIC_` を付けてよいのは公開鍵のみ。秘密鍵に付けたら即座に鍵を再生成する。

### 2. Service Worker

`public/sw.js` に置き、`navigator.serviceWorker.register("/sw.js")` で登録する。

処理するイベント:

- `push` — ペイロードを表示。**`event.data` が空のケースを必ずハンドリングする**（一部ブラウザで起こる）
- `notificationclick` — 通知を閉じ、`/review` を開く

`public/` の素の JS なので TypeScript で書けない。ESLint / tsconfig の対象外設定が必要になる場合がある。

### 3. 購読フロー

```
1. Notification.permission を確認
2. 未許可なら requestPermission()（ユーザー操作起点で呼ぶ）
3. pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
4. 購読情報を API で送信
5. PushSubscription に upsert（endpoint がユニークキー）
```

- **拒否された場合の UI を必ず用意する。** ブラウザ設定からしか戻せないため、その旨を案内する
- Push 非対応ブラウザでは購読 UI を出さない（機能検出する）
- **1ユーザーあたりの購読数に上限を設ける**（例: 10）。端末ごとに1行増える設計なので、上限がないと無制限に積める
- **通知の ON/OFF は `PushSubscription` の削除で表現する。** `notificationEnabled` カラムは作らない（後からのマイグレーションを避けるため、ここで決めておく）

### 4. ★ 購読情報の検証（重要）

**`endpoint` を検証せずに保存しない。**

Lambda の API は公開されている。任意の URL を `endpoint` として保存されると、夜間バッチがその URL へリクエストを送る踏み台になる。CPU 時間を浪費させられるおそれもある。

Zod スキーマで検証する:

- `endpoint` は `https://` 必須（`http://` を弾く）
- **既知のプッシュサービスのドメイン許可リスト**で絞る（`fcm.googleapis.com`、`updates.push.services.mozilla.com`、`*.notify.windows.com`、Apple のドメイン等）
- `keys.p256dh` / `keys.auth` の base64url 形式と長さを検証
- 全体の長さ上限を設ける

#### ★ 比較方法を間違えない

```
❌ endpoint.startsWith("https://fcm.googleapis.com")
   → https://fcm.googleapis.com.attacker.com/... が通ってしまう

✅ const host = new URL(endpoint).hostname;
   → 許可ドメインと完全一致、またはドット境界を含むサフィックス一致で比較
```

**文字列の前方一致で判定すると許可リストが意味を失う。** 必ず `URL` でホスト名を抽出してから比較する。テストに「サブドメイン偽装での回避」を必ず入れる。

### 5. 送信対象の判定 (`schedule.ts`)

**純粋関数として切り出す。**

```
findUsersToNotify(users, nowUtc) → User[]
```

- ユーザーの `timezone` で現在時刻を求め、`notificationTime` と比較する
- **二重送信ガード**: `User.lastNotifiedDate`（`YYYY-MM-DD`）が今日と同じなら対象外にする
- 日付キーの算出はステップ8の `getTodayKey()` を再利用する（DRY）

**`lastNotifiedDate` は `users` の要素に含まれるので、シグネチャを変えずにガードを実装できる。** ステップ3でカラムを用意してある。

送信成功後に `lastNotifiedDate` を更新する。

### 6. 通知時刻の粒度（決めること）

`notificationTime` が `"06:30"` のような分単位を許すなら、スケジュールもそれに合わせる必要がある。**毎時0分にしか発火しないのに分を許すと、その設定のユーザーには永遠に通知が届かない。しかもエラーが出ないので気づけない。**

**決定: 毎時発火 + 設定は毎正時のみに制限する**（KISS）。設定画面の Zod スキーマで `"HH:00"` 形式のみ許可し、UI もプルダウンで毎正時から選ばせる。

README にも「毎正時から選択」と書く。自由入力にすると `"06:30"` を設定した人に永久に通知が届かない。

### 7. 問題の事前生成バッチ

```
1. ユーザーごとに Vocabulary と Question 数を取得
2. findVocabulariesToFill() で対象を選ぶ
     - 問題数 < TARGET_QUESTIONS_PER_VOCABULARY の単語
     - 問題数が少ない順
     - 上限 MAX_VOCABULARIES_PER_BATCH
3. generateQuestionsForVocabulary()（ステップ6）を呼ぶ
4. 保存
```

定数は**ステップ6の `lambda/src/lib/constants.ts` に追記する**（散らさない）。

| 定数 | 意味 | 初期値 |
| --- | --- | --- |
| `MAX_VOCABULARIES_PER_BATCH` | 1回で処理する単語数 | 5 |
| `MAX_QUESTIONS_PER_VOCABULARY_PER_BATCH` | 1単語あたり1回で作る数 | 2 |
| `GENERATION_RETRY_COOLDOWN_DAYS` | 失敗した単語を再挑戦させるまでの日数 | 7 |

`MAX_GENERATION_FAILURES` はステップ6の定数表で定義済み。**ここで重複定義しない。**

**上限を必ず設ける。** 単語を大量登録した翌日に Gemini の無料枠を使い切るのを防ぐ。急ぐ必要はなく、毎晩少しずつ増えれば十分。足りない間は出題時のフォールバックが埋める。

**1単語の失敗で残りを止めない。** 個別に捕捉してログを残し、処理を続行する。

#### ★ 失敗し続ける単語を除外する

対象は「問題数が少ない順」に選ぶため、**生成が恒常的に失敗する単語は問題数0のまま毎晩必ず最優先で選ばれ続ける。** 極端に短い語や、Gemini が毎回 Zod 検証に落ちる出力を返す語で起こる。

放置すると毎晩 `GEMINI_MAX_RETRIES` 回ぶんの呼び出しが無駄になり、**他の単語のプールが永久に育たない。**

- 失敗したら `Vocabulary.generationFailCount` を加算し、`lastGenerationAttemptAt` を記録する
- 成功したら `generationFailCount` を 0 に戻す

**除外条件は「失敗回数 + クールダウン」の組み合わせにする。**

```
除外する = generationFailCount >= MAX_GENERATION_FAILURES
          かつ lastGenerationAttemptAt が GENERATION_RETRY_COOLDOWN_DAYS 以内
```

**失敗回数だけで永久除外にしない。** それだと「成功したらリセット」の条件を満たす機会が二度と来ず、その単語は永久に問題0件のままになる。クールダウン後に再挑戦させることで、一時的な失敗から回復できる。

回復経路はもう1つある。**ユーザーが単語を編集したら `generationFailCount` を 0 にリセットする**（ステップ5）。意味やコアイメージを直したのに再試行されないのは不自然なため。

### 8. EventBridge のスケジュール

`template.yaml` に定義する。

| バッチ | 実行（JST） | UTC |
| --- | --- | --- |
| 通知 | 毎時0分 | 毎時0分 |
| 問題生成 | 02:00 | 前日 17:00 |

**生成バッチは通知より前に走らせる。** 朝の通知で復習を始めたときにプールが育っている状態にするため。

EventBridge のスケジュール式は UTC で解釈される。

### 9. 送信失敗の処理

- **410 Gone / 404 が返った購読は無効。** DB から削除する（放置すると毎日失敗し続ける）
- 1ユーザーの失敗で全体を止めない

## テスト

**先に書く（RED）:**

`schedule.ts`（最重要）

- `Asia/Tokyo` の 06:00 に対象になる
- 05:00 / 07:00 では対象にならない
- 異なるタイムゾーンのユーザーがそれぞれ正しい時刻に対象になる
- **`lastNotifiedDate` が今日なら対象から外れる**
- 日付をまたぐ UTC 変換（日本 06:00 = 前日 UTC 21:00）

`validation/subscription.ts`

- 許可リスト外のドメインが弾かれる
- **`https://fcm.googleapis.com.attacker.com/...` のようなサブドメイン偽装が弾かれる**（最重要）
- `http://` が弾かれる
- `keys` の形式不正が弾かれる

`find-vocabularies-to-fill.ts`

- 目標に達している単語は対象外
- 問題数が少ない単語が優先される
- `MAX_VOCABULARIES_PER_BATCH` を超えない
- **`generationFailCount` が上限に達した単語が対象から外れる**
- **クールダウン期間を過ぎた失敗単語が再び対象に戻る**
- 単語0件で空配列

`send.ts` / 生成バッチ（送信・Gemini はモック）

- 410 の購読が削除される
- 1件失敗しても残りが続行される
- 生成数が上限を超えない

`base64.ts`

- 正常な base64url、パディングあり/なし、不正入力

**手動確認:**

- 実機で購読 → 通知が届く → タップで `/review` が開く

## 完了条件 (DoD)

- [ ] 実機で通知を受け取れる
- [ ] EventBridge から両バッチが起動する
- [ ] 許可リスト外の `endpoint` が保存できない
- [ ] 無効な購読が自動削除される
- [ ] **二重送信が起きない**
- [ ] 生成バッチが上限を守る（Gemini 呼び出し数を実測）
- [ ] カバレッジ 80% 以上

## 注意点

- **iOS Safari の Web Push はホーム画面に追加した PWA でのみ動作する。** ブラウザタブでは届かない。設定画面にこの案内を明記する。有効な `manifest` とアイコンも必須
- **アイコン画像を忘れない。** `manifest` が参照するファイルが無いと PWA として認識されない
- Service Worker は強くキャッシュされる。開発中は DevTools の "Update on reload" を使う
- EventBridge の動作確認は、Lambda のテスト実行機能で手動起動して確かめる。本番スケジュールを待たない
- 通知本文に単語そのものを入れるかは好みが分かれる。ロック画面に表示される点を踏まえて決める。**既定は汎用文言（「復習の時間です」）を推奨**
