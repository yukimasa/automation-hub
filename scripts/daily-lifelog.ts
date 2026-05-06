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
  const targetDate = getYesterdayJST();

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
  const systemPrompt = await getPageMarkdown(process.env.NIPPO_SKILL_PAGE_ID!);

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
