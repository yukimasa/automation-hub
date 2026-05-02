# automation-hub

GitHub Actions の cron（JST 07:00）で前日の Limitless データから日報を生成し Notion に書き込むバッチ。

## セットアップ手順

### 1. リポジトリをクローン
```bash
git clone https://github.com/<your-org>/automation-hub.git
cd automation-hub
npm install
```

### 2. 環境変数を設定
```bash
cp .env.example .env
# .env を編集して各値を入力する
```

| 変数名 | 説明 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API キー |
| `NOTION_TOKEN` | Notion インテグレーション トークン |
| `NIPPO_SKILL_PAGE_ID` | 日報生成スキルページの Notion ページ ID |
| `LIMITLESS_RAW_DB_ID` | db_limitless_raw の Notion データベース ID |
| `LIFELOG_DB_ID` | db_lifelog の Notion データベース ID |
| `SYSTEM_LOGS_DB_ID` | db_system_logs の Notion データベース ID |

### 3. ローカル実行
```bash
npx tsx scripts/daily-lifelog.ts
```

成功すると Notion の db_lifelog に昨日付の日報ページが作成され、db_system_logs に INFO ログが 2 件記録されます。

## GitHub Actions

`.github/workflows/daily-lifelog.yml` で毎朝 JST 07:00（UTC 22:00）に自動実行されます。
`workflow_dispatch` で手動実行も可能です。

GitHub Secrets に上記 6 つの環境変数を登録してください。
