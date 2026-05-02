import "dotenv/config";
import { queryDatabase } from "../lib/notion.js";
import { logToSystemLogs } from "../lib/system-logs.js";
import { getLastWeekRangeJST } from "../lib/date.js";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";

const SOURCE = "データ整合性チェックAI";

function getDateProp(page: PageObjectResponse, propName: string): string | null {
  const prop = page.properties[propName];
  if (!prop || prop.type !== "date") return null;
  return prop.date?.start?.slice(0, 10) ?? null;
}

function getDatesBetween(start: string, end: string): string[] {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const dates: string[] = [];
  for (let ms = Date.UTC(sy, sm - 1, sd); ms <= Date.UTC(ey, em - 1, ed); ms += 86400000) {
    const d = new Date(ms);
    dates.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
    );
  }
  return dates;
}

async function main() {
  const { start, end } = getLastWeekRangeJST();
  const allDates = getDatesBetween(start, end);

  await logToSystemLogs({
    title: "データ整合性チェック 実行開始",
    level: "INFO",
    content: `対象期間: ${start} 〜 ${end}`,
    relatedDbs: ["limitless_raw", "lifelog"],
    source: SOURCE,
  });

  // raw がある日付を収集
  const rawPages = await queryDatabase(process.env.LIMITLESS_RAW_DB_ID!, {
    and: [
      { property: "記録日", date: { on_or_after: start } },
      { property: "記録日", date: { on_or_before: end } },
    ],
  });

  const rawDates = new Set<string>();
  for (const page of rawPages) {
    const d = getDateProp(page, "記録日");
    if (d) rawDates.add(d);
  }

  const rawZeroDates = allDates.filter((d) => !rawDates.has(d));

  // raw がある日付ごとに日報の存在確認
  const inconsistencies: string[] = [];

  for (const date of [...rawDates].sort()) {
    const lifelogs = await queryDatabase(process.env.LIFELOG_DB_ID!, {
      property: "日報日付",
      date: { equals: date },
    });
    if (lifelogs.length === 0) inconsistencies.push(date);
  }

  const rawDatesSorted = [...rawDates].sort();
  const detail = [
    `対象期間: ${start} 〜 ${end}`,
    ``,
    `raw有り日（${rawDatesSorted.length}日）: ${rawDatesSorted.join(", ") || "なし"}`,
    `raw無し日・チェック対象外（${rawZeroDates.length}日）: ${rawZeroDates.join(", ") || "なし"}`,
  ].join("\n");

  if (inconsistencies.length === 0) {
    await logToSystemLogs({
      title: "データ整合性チェック 完了（問題なし）",
      level: "INFO",
      content: detail + "\n\n不整合なし。全raw日付に日報あり。",
      relatedDbs: ["limitless_raw", "lifelog"],
      source: SOURCE,
    });
  } else {
    await logToSystemLogs({
      title: "データ整合性チェック 警告（不整合あり）",
      level: "WARNING",
      content:
        detail +
        `\n\n## 不整合（${inconsistencies.length}件）\n\n` +
        `rawがあるのに日報が存在しない日付:\n${inconsistencies.map((d) => `- ${d}`).join("\n")}\n\n` +
        `推奨アクション: 上記日付の日報生成を手動で確認・再実行してください。`,
      relatedDbs: ["limitless_raw", "lifelog"],
      source: SOURCE,
    });
  }
}

main().catch(async (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  await logToSystemLogs({
    title: "データ整合性チェック エラー",
    level: "ERROR",
    content: message,
    relatedDbs: ["limitless_raw", "lifelog"],
    source: SOURCE,
  }).catch(() => {});
  console.error(message);
  process.exit(1);
});
