import "dotenv/config";
import { queryDatabase, createPageRaw } from "../lib/notion.js";
import { logToSystemLogs } from "../lib/system-logs.js";
import type { BlockObjectRequest } from "@notionhq/client/build/src/api-endpoints.js";

const SOURCE = "Limitless同期";
const LOOKBACK_MINUTES = 1500; // 25時間（前日分をカバー）
const LIMITLESS_LIMIT = 50;
const THROTTLE_MS = 350;

interface LimitlessLifelog {
  id: string;
  title: string;
  startTime: string | null;
  endTime: string | null;
  markdown: string | null;
}

function formatJSTDatetime(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) =>
    (parts.find((p) => p.type === type)?.value ?? "00").padStart(2, "0");
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function formatJSTDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url: string, options: RequestInit): Promise<Response> {
  const RETRY_CODES = new Set([429, 500, 502, 503, 504]);
  let lastResp: Response | null = null;

  for (let attempt = 0; attempt <= 3; attempt++) {
    const resp = await fetch(url, options);
    if (resp.ok || !RETRY_CODES.has(resp.status)) return resp;
    lastResp = resp;

    const waitMs =
      resp.status === 429
        ? Math.max(1000, Number(resp.headers.get("retry-after") ?? "2") * 1000)
        : Math.min(30000, 1000 * Math.pow(2, attempt) + Math.random() * 250);

    await sleep(waitMs);
  }

  return lastResp!;
}

async function fetchLifelogs(token: string, since: Date, until: Date): Promise<LimitlessLifelog[]> {
  const all: LimitlessLifelog[] = [];
  let cursor: string | null = null;

  do {
    const start = formatJSTDatetime(since);
    const end = formatJSTDatetime(until);
    let url =
      `https://api.limitless.ai/v1/lifelogs` +
      `?timezone=${encodeURIComponent("Asia/Tokyo")}` +
      `&start=${encodeURIComponent(start)}` +
      `&end=${encodeURIComponent(end)}` +
      `&limit=${LIMITLESS_LIMIT}` +
      `&direction=asc` +
      `&includeMarkdown=true` +
      `&includeContents=false`;

    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

    const resp = await fetchWithRetry(url, {
      headers: { "X-API-Key": token.trim() },
    });

    if (!resp.ok) throw new Error(`Limitless API error: ${resp.status} - ${await resp.text()}`);

    const data = await resp.json() as {
      data: { lifelogs: LimitlessLifelog[] };
      meta: { lifelogs: { nextCursor: string | null } };
    };

    all.push(...(data?.data?.lifelogs ?? []));
    cursor = data?.meta?.lifelogs?.nextCursor ?? null;
  } while (cursor);

  return all;
}

async function hasLifelogId(lifelogId: string): Promise<boolean> {
  const results = await queryDatabase(process.env.LIMITLESS_RAW_DB_ID!, {
    property: "lifelog ID",
    rich_text: { equals: lifelogId },
  });
  return results.length > 0;
}

function buildContentBlocks(markdown: string | null): BlockObjectRequest[] {
  const text = markdown?.trim();
  if (!text) {
    return [{
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: "(記録なし)" } }] },
    }];
  }

  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 1900) chunks.push(text.slice(i, i + 1900));

  return chunks.map((chunk) => ({
    type: "paragraph" as const,
    paragraph: { rich_text: [{ type: "text" as const, text: { content: chunk } }] },
  }));
}

async function createLifelogPage(lifelog: LimitlessLifelog): Promise<boolean> {
  const recordDate = lifelog.startTime ? formatJSTDate(new Date(lifelog.startTime)) : null;

  const properties: Record<string, unknown> = {
    トピックタイトル: { title: [{ text: { content: lifelog.title || "無題" } }] },
    "lifelog ID": { rich_text: [{ text: { content: lifelog.id } }] },
    取得日時: { date: { start: new Date().toISOString() } },
  };

  if (lifelog.startTime) properties["開始時刻"] = { date: { start: lifelog.startTime } };
  if (lifelog.endTime) properties["終了時刻"] = { date: { start: lifelog.endTime } };
  if (recordDate) properties["記録日"] = { date: { start: recordDate } };

  const blocks = buildContentBlocks(lifelog.markdown);

  try {
    await createPageRaw(process.env.LIMITLESS_RAW_DB_ID!, properties, blocks);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ 保存失敗 ${lifelog.id}: ${msg}`);
    return false;
  }
}

async function main() {
  const until = new Date();
  const since = new Date(until.getTime() - LOOKBACK_MINUTES * 60 * 1000);

  await logToSystemLogs({
    title: "Limitless同期 実行開始",
    level: "INFO",
    content: `取得範囲: ${since.toISOString()} 〜 ${until.toISOString()}`,
    relatedDbs: ["limitless_raw"],
    source: SOURCE,
  });

  const lifelogs = await fetchLifelogs(process.env.LIMITLESS_API_TOKEN!, since, until);

  if (lifelogs.length === 0) {
    await logToSystemLogs({
      title: "Limitless同期 スキップ（データなし）",
      level: "INFO",
      content: `対象期間にLifelogなし`,
      relatedDbs: ["limitless_raw"],
      source: SOURCE,
    });
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const lifelog of lifelogs) {
    const exists = await hasLifelogId(lifelog.id);
    if (exists) { skipped++; continue; }

    const ok = await createLifelogPage(lifelog);
    if (ok) created++;

    await sleep(THROTTLE_MS);
  }

  await logToSystemLogs({
    title: "Limitless同期 完了",
    level: "INFO",
    content: `取得: ${lifelogs.length}件 / 新規作成: ${created}件 / スキップ: ${skipped}件`,
    relatedDbs: ["limitless_raw"],
    source: SOURCE,
  });
}

main().catch(async (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  await logToSystemLogs({
    title: "Limitless同期 エラー",
    level: "ERROR",
    content: message,
    relatedDbs: ["limitless_raw"],
    source: SOURCE,
  }).catch(() => {});
  console.error(message);
  process.exit(1);
});
