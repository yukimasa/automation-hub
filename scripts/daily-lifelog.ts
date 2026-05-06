import "dotenv/config";
import { getYesterdayJST } from "../lib/date.js";
import { getPageMarkdown, queryDatabase, createPage } from "../lib/notion.js";
import { chat } from "../lib/anthropic.js";
import { logToSystemLogs } from "../lib/system-logs.js";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";

function getPageTitle(page: PageObjectResponse): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title" && prop.title.length > 0) {
      return prop.title.map((r) => r.plain_text).join("");
    }
  }
  return "(無題)";
}

async function main() {
  const targetDate = process.env.TARGET_DATE || getYesterdayJST();

  await logToSystemLogs({
    title: "日報生成AI 実行開始",
    level: "INFO",
    content: `対象日: ${targetDate}`,
    relatedDbs: ["limitless_raw", "lifelog"],
  });

  // 既存日報チェック
  const existing = await queryDatabase(process.env.LIFELOG_DB_ID!, {
    property: "日報日付",
    date: { equals: targetDate },
  });

  if (existing.length > 0) {
    await logToSystemLogs({
      title: "日報生成AI スキップ（既存日報あり）",
      level: "INFO",
      content: `対象日: ${targetDate} の日報が既に存在します（page_id: ${existing[0].id}）`,
      relatedDbs: ["lifelog"],
    });
    return;
  }

  // 前日 raw データ取得
  const rawPages = await queryDatabase(
    process.env.LIMITLESS_RAW_DB_ID!,
    { property: "記録日", date: { equals: targetDate } },
    [{ property: "開始時刻", direction: "ascending" }]
  );

  if (rawPages.length === 0) {
    await logToSystemLogs({
      title: "日報生成AI スキップ（前日データ0件）",
      level: "INFO",
      content: `対象日: ${targetDate} の limitless_raw が0件でした`,
      relatedDbs: ["limitless_raw"],
    });
    return;
  }

  // 各 raw ページのテキストを収集
  const rawTexts: string[] = [];

  for (const page of rawPages) {
    const title = getPageTitle(page);
    const body = await getPageMarkdown(page.id);
    rawTexts.push(`## ${title}\n${body}`);
  }

  const userMessage = `対象日: ${targetDate}\n\n${rawTexts.join("\n\n---\n\n")}`;

  // system prompt を Notion から取得
  const skillPrompt = await getPageMarkdown(process.env.NIPPO_SKILL_PAGE_ID!);
  const systemPrompt = `${skillPrompt}

## 🔧 このバッチでの出力ルール（最優先）

このスクリプトは limitless_raw クエリ・既存日報チェック・db_lifelog ページ作成・db_system_logs ログ記録をすべてコード側で実行する。あなたの仕事は **対象日の日報本文（Markdown）を生成すること** のみ。

- 「ステップN：...」のような手順説明、実行ログのテンプレ、保存仕様の説明、前置き／後書きを一切出力しない
- あなたの応答テキスト全体がそのまま db_lifelog の対象日ページ本文として保存される
- 出力は \`## 主な出来事（時系列順）\` などのセクション見出しから始める（スキル定義「5) 出力テンプレ」の構成に従う）`;

  // 日報生成
  const markdown = await chat(systemPrompt, userMessage);

  // db_lifelog にページ作成
  await createPage(
    process.env.LIFELOG_DB_ID!,
    {
      日報タイトル: { title: [{ text: { content: `${targetDate} 日報` } }] },
      日報日付: { date: { start: targetDate } },
      主な情報源: { select: { name: "Limitless Pendant" } },
      参照元raw: { relation: rawPages.map((p) => ({ id: p.id })) },
    },
    markdown
  );

  await logToSystemLogs({
    title: "日報生成AI 完了",
    level: "INFO",
    content: `対象日: ${targetDate} の日報を生成しました（raw ${rawPages.length}件）`,
    relatedDbs: ["limitless_raw", "lifelog"],
  });
}

main().catch(async (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  await logToSystemLogs({
    title: "日報生成AI エラー",
    level: "ERROR",
    content: message,
    relatedDbs: ["limitless_raw", "lifelog"],
  }).catch(() => {});
  console.error(message);
  process.exit(1);
});
