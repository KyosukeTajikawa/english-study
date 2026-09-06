# English Study App

英単語・イディオムを登録すると、AI が問題を自動生成してくれる学習アプリ。毎日10問の復習を通知でリマインドし、覚えた単語を定着させる。

## 特徴

### 📖 コアイメージで覚える単語帳

単語・イディオムに加えて、意味、**コアイメージ**、例文を登録できる。丸暗記ではなく、その語が持つ感覚ごと記憶に残す。

### 🤖 AI による問題の自動生成

Google Gemini が、登録した単語から問題・選択肢・解説を生成する。自分で問題を作る必要はない。生成済みの問題は再利用されるため、同じ問題ばかり出ることも、API を無駄に消費することもない。

### 🔁 毎日10問の復習

その日の10問は「まだ出していない」「間違えた」「まだ定着していない」単語を優先して選ばれる。**一度決まったセットはその日の間は変わらない**ので、途中でやめても続きから再開できる。

### 🔔 毎朝のリマインド通知

毎日 06:00（日本時間）に Web Push で通知が届く。通知をタップすればそのまま復習画面へ。通知時刻とタイムゾーンは設定から変更できる。

## 技術構成

| 領域 | 採用技術 |
| --- | --- |
| フレームワーク | Next.js 16（App Router）+ React 19 + TypeScript |
| スタイリング | Tailwind CSS v4 |
| データベース | Cloudflare D1 + Prisma |
| AI | Google Gemini API |
| ホスティング | Cloudflare Workers |
| 通知 | Web Push + Cloudflare Cron Triggers |

## 必要なもの

- Node.js 20 以上
- [Google Gemini API キー](https://aistudio.google.com/apikey)
- Cloudflare アカウント（デプロイする場合）

## セットアップ

```bash
git clone https://github.com/<your-account>/English-study-app.git
cd English-study-app
npm install
```

### 環境変数

`.env.example` をコピーして `.env.local` を作成し、値を設定する。

```bash
cp .env.example .env.local
```

| 変数 | 説明 |
| --- | --- |
| `GEMINI_API_KEY` | Gemini API キー |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Web Push の公開鍵 |
| `VAPID_PRIVATE_KEY` | Web Push の秘密鍵 |
| `CRON_SECRET` | 通知バッチを保護する任意の文字列 |

Web Push の鍵は以下で生成できる。

```bash
npx web-push generate-vapid-keys
```

### データベースの準備

```bash
npm run db:migrate:local
npm run db:seed
```

### 起動

```bash
npm run dev
```

http://localhost:3000 を開く。

## デプロイ

Cloudflare Workers にデプロイする。初回のみシークレットを登録する。

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put CRON_SECRET
```

本番データベースにマイグレーションを適用してからデプロイする。

```bash
npm run db:migrate:remote
npm run deploy
```

## 注意

- iOS で通知を受け取るには、Safari の共有メニューから**ホーム画面に追加**する必要がある。ブラウザのタブのままでは通知が届かない。
- Gemini API の無料枠には上限がある。問題は生成後に保存・再利用されるため通常の利用で超えることはないが、大量の単語を一度に登録すると消費が増える。

## ライセンス

MIT
