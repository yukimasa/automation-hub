# automation-hub

Notion × Anthropic Claude を使った自動化バッチ集。GitHub Actions の cron で定期実行される。

## ジョブ一覧

| ジョブ | スクリプト | 実行頻度 | 概要 |
|---|---|---|---|
| 日報生成 | `scripts/daily-lifelog.ts` | 毎日 JST 07:00 | Limitless の前日データから日報を生成し db_lifelog に書き込む |
| Identity抽出 | `scripts/weekly-identity.ts` | 毎週月曜 JST 09:00 | 前週の日報から価値観・意思決定を抽出し db_identity / db_decisions に反映する |

## セットアップ

### 1. リポジトリをクローン
```bash
git clone https://github.com/yukimasa/automation-hub.git
cd automation-hub
npm install
```

### 2. 環境変数を設定
```bash
cp .env.example .env
# .env を編集して各値を入力する
```

| 変数名 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API キー（全ジョブ共通） |
| `NOTION_TOKEN` | Notion インテグレーション トークン（全ジョブ共通） |
| `SYSTEM_LOGS_DB_ID` | db_system_logs（全ジョブ共通） |
| `LIFELOG_DB_ID` | db_lifelog（日報生成・Identity抽出） |
| `NIPPO_SKILL_PAGE_ID` | 日報生成スキルページ ID（日報生成） |
| `LIMITLESS_RAW_DB_ID` | db_limitless_raw（日報生成） |
| `IDENTITY_DB_ID` | db_identity（Identity抽出） |
| `DECISIONS_DB_ID` | db_decisions（Identity抽出） |
| `IDENTITY_SKILL_PAGE_ID` | Identity抽出スキルページ ID（Identity抽出） |

### 3. ローカル実行
```bash
npm run daily-lifelog     # 日報生成
npm run weekly-identity   # Identity抽出
```

## GitHub Actions

各ジョブは `.github/workflows/` 以下のワークフローで自動実行される。`workflow_dispatch` による手動実行も可能。

GitHub Secrets に上記の環境変数を登録すること。
