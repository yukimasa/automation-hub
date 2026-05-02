import { createPage } from "./notion.js";
import { getTodayJST } from "./date.js";

interface LogParams {
  title: string;
  level: "INFO" | "WARNING" | "ERROR";
  content: string;
  relatedDbs?: string[];
  source?: string;
}

export async function logToSystemLogs(params: LogParams): Promise<void> {
  const { title, level, content, relatedDbs = [], source = "日報生成AI" } = params;

  const properties: Record<string, unknown> = {
    ログタイトル: { title: [{ text: { content: title } }] },
    実行日時: { date: { start: getTodayJST() } },
    ログレベル: { select: { name: level } },
    ログ内容: { rich_text: [{ text: { content } }] },
    実行元: { rich_text: [{ text: { content: source } }] },
    解決: { checkbox: false },
  };

  if (relatedDbs.length > 0) {
    properties["関連DB"] = { multi_select: relatedDbs.map((name) => ({ name })) };
  }

  await createPage(process.env.SYSTEM_LOGS_DB_ID!, properties, "");
}
