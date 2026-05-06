import "dotenv/config";
import { getLastWeekRangeJST, getTodayJST } from "../lib/date.js";
import { getPageMarkdown, queryDatabase, createPage, updatePage } from "../lib/notion.js";
import { chat } from "../lib/anthropic.js";
import { logToSystemLogs } from "../lib/system-logs.js";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";

const SOURCE = "週次Identity抽出AI";

function pageUrl(page: PageObjectResponse): string {
  return `https://www.notion.so/${page.id.replace(/-/g, "")}`;
}

function getTitle(page: PageObjectResponse): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title" && prop.title.length > 0) {
      return prop.title.map((r) => r.plain_text).join("");
    }
  }
  return "(無題)";
}

function getText(page: PageObjectResponse, propName: string): string {
  const prop = page.properties[propName];
  if (!prop || prop.type !== "rich_text") return "";
  return prop.rich_text.map((r) => r.plain_text).join("");
}

function getSelect(page: PageObjectResponse, propName: string): string {
  const prop = page.properties[propName];
  if (!prop) return "";
  if (prop.type === "select") return prop.select?.name ?? "";
  if (prop.type === "status") return prop.status?.name ?? "";
  return "";
}

function getMultiSelect(page: PageObjectResponse, propName: string): string[] {
  const prop = page.properties[propName];
  if (!prop || prop.type !== "multi_select") return [];
  return prop.multi_select.map((s) => s.name);
}

function getNumber(page: PageObjectResponse, propName: string): number | null {
  const prop = page.properties[propName];
  if (!prop || prop.type !== "number") return null;
  return prop.number;
}

function getCheckbox(page: PageObjectResponse, propName: string): boolean {
  const prop = page.properties[propName];
  if (!prop || prop.type !== "checkbox") return false;
  return prop.checkbox;
}

interface IdentityCreate {
  type: "create";
  "原則・価値観": string;
  "カテゴリ"?: string;
  "重要度"?: number;
  "適用場面"?: string[];
  "詳細説明"?: string;
  "元ログの参照"?: string;
  lifelogPageIds?: string[];
}

interface IdentityUpdate {
  type: "update";
  pageId: string;
  updates: {
    "ステータス"?: string;
    "変更理由"?: string;
    "詳細説明"?: string;
  };
}

interface DecisionCreate {
  type: "create";
  "意思決定内容": string;
  "決定日"?: string;
  "意思決定の種類"?: string;
  "根拠"?: string;
  "代替案"?: string;
  "リスク"?: string;
  "元ログの参照"?: string;
  lifelogPageIds?: string[];
}

interface DecisionUpdate {
  type: "update";
  pageId: string;
  updates: {
    "ステータス"?: string;
  };
}

interface ExtractionResult {
  skip: boolean;
  skipReason?: string;
  identityActions: (IdentityCreate | IdentityUpdate)[];
  decisionActions: (DecisionCreate | DecisionUpdate)[];
  summary: {
    newIdentity: number;
    newDecisions: number;
    updatedIdentity: number;
    updatedDecisions: number;
  };
}

const JSON_OUTPUT_INSTRUCTION = `

## 🔧 出力フォーマット（必須）

以下のJSON形式のみを出力してください。コードブロック（\`\`\`json ... \`\`\`）で囲むこと。

\`\`\`json
{
  "skip": false,
  "skipReason": null,
  "identityActions": [
    {
      "type": "create",
      "原則・価値観": "...",
      "カテゴリ": "価値観",
      "重要度": 8,
      "適用場面": ["仕事"],
      "詳細説明": "...",
      "元ログの参照": "引用テキスト",
      "lifelogPageIds": ["page-uuid"]
    },
    {
      "type": "update",
      "pageId": "existing-page-uuid",
      "updates": {
        "ステータス": "過去",
        "変更理由": "..."
      }
    }
  ],
  "decisionActions": [
    {
      "type": "create",
      "意思決定内容": "...",
      "決定日": "YYYY-MM-DD",
      "意思決定の種類": "戦略",
      "根拠": "...",
      "代替案": "...",
      "リスク": "...",
      "元ログの参照": "引用テキスト",
      "lifelogPageIds": ["page-uuid"]
    }
  ],
  "summary": {
    "newIdentity": 0,
    "newDecisions": 0,
    "updatedIdentity": 0,
    "updatedDecisions": 0
  }
}
\`\`\`

スキップする場合は "skip": true, "skipReason": "理由" にして他フィールドは空配列/0にすること。`;

async function main() {
  const { start, end } = getLastWeekRangeJST();
  const today = getTodayJST();

  await logToSystemLogs({
    title: "週次Identity抽出AI 実行開始",
    level: "INFO",
    content: `対象期間：${start} 〜 ${end}（前週）`,
    relatedDbs: ["lifelog", "identity", "decisions"],
    source: SOURCE,
  });

  const lifelogPages = await queryDatabase(
    process.env.LIFELOG_DB_ID!,
    {
      and: [
        { property: "日報日付", date: { on_or_after: start } },
        { property: "日報日付", date: { on_or_before: end } },
      ],
    },
    [{ property: "日報日付", direction: "ascending" }]
  );

  if (lifelogPages.length === 0) {
    await logToSystemLogs({
      title: "週次Identity抽出AI スキップ",
      level: "INFO",
      content: `対象期間：${start} 〜 ${end}\n\n理由：処理済みまたは新規抽出対象なし`,
      relatedDbs: ["lifelog", "identity", "decisions"],
      source: SOURCE,
    });
    return;
  }

  const lifelogContents: Array<{ id: string; title: string; url: string; body: string }> = [];
  for (const page of lifelogPages) {
    const body = await getPageMarkdown(page.id);
    lifelogContents.push({ id: page.id, title: getTitle(page), url: pageUrl(page), body });
  }

  const [identityPages, decisionPages] = await Promise.all([
    queryDatabase(
      process.env.IDENTITY_DB_ID!,
      { property: "ステータス", status: { equals: "現行" } }
    ),
    queryDatabase(
      process.env.DECISIONS_DB_ID!,
      { property: "ステータス", status: { equals: "現行" } }
    ),
  ]);

  const lifelogSection = lifelogContents
    .map((l) => `### ${l.title}\npage_id: ${l.id}\nURL: ${l.url}\n\n${l.body}`)
    .join("\n\n---\n\n");

  const identitySection = identityPages.length === 0
    ? "（なし）"
    : identityPages
        .map((p) => {
          const scenes = getMultiSelect(p, "適用場面").join(", ");
          const details = getText(p, "詳細説明").slice(0, 150);
          return `- page_id: ${p.id}\n  原則・価値観: ${getTitle(p)}\n  カテゴリ: ${getSelect(p, "カテゴリ")}\n  重要度: ${getNumber(p, "重要度") ?? "未設定"}\n  適用場面: ${scenes}\n  不変性: ${getCheckbox(p, "不変性")}\n  詳細説明: ${details}`;
        })
        .join("\n\n");

  const decisionsSection = decisionPages.length === 0
    ? "（なし）"
    : decisionPages
        .map((p) => {
          const basis = getText(p, "根拠").slice(0, 150);
          return `- page_id: ${p.id}\n  意思決定内容: ${getTitle(p)}\n  種類: ${getSelect(p, "意思決定の種類")}\n  根拠: ${basis}`;
        })
        .join("\n\n");

  const systemPrompt = await getPageMarkdown(process.env.IDENTITY_SKILL_PAGE_ID!) + JSON_OUTPUT_INSTRUCTION;

  const userMessage = `対象期間：${start} 〜 ${end}（前週）

## 前週の日報一覧（${lifelogContents.length}件）

${lifelogSection}

---

## 既存Identity（現行）一覧（${identityPages.length}件）

${identitySection}

---

## 既存Decisions（現行）一覧（${decisionPages.length}件）

${decisionsSection}`;

  const responseText = await chat(systemPrompt, userMessage, 16384);

  const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    throw new Error(`Claudeレスポンスにjsonブロックが見つかりません:\n${responseText.slice(0, 500)}`);
  }

  const result: ExtractionResult = JSON.parse(jsonMatch[1]);

  if (result.skip) {
    await logToSystemLogs({
      title: "週次Identity抽出AI スキップ",
      level: "INFO",
      content: `対象期間：${start} 〜 ${end}\n\n理由：${result.skipReason ?? "処理済みまたは新規抽出対象なし"}`,
      relatedDbs: ["lifelog", "identity", "decisions"],
      source: SOURCE,
    });
    return;
  }

  const createdIdentityUrls: string[] = [];
  const createdDecisionUrls: string[] = [];

  for (const action of result.identityActions) {
    if (action.type === "create") {
      const props: Record<string, unknown> = {
        "原則・価値観": { title: [{ text: { content: action["原則・価値観"] } }] },
        "AI抽出": { checkbox: true },
        "抽出日": { date: { start: today } },
        "初回記録日": { date: { start: today } },
        "ステータス": { status: { name: "現行" } },
        "不変性": { checkbox: false },
      };
      if (action["カテゴリ"]) props["カテゴリ"] = { select: { name: action["カテゴリ"] } };
      if (action["重要度"] != null) props["重要度"] = { number: action["重要度"] };
      if (action["適用場面"]?.length) props["適用場面"] = { multi_select: action["適用場面"].map((n) => ({ name: n })) };
      if (action["詳細説明"]) props["詳細説明"] = { rich_text: [{ text: { content: action["詳細説明"] } }] };
      if (action["元ログの参照"]) props["元ログの参照"] = { rich_text: [{ text: { content: action["元ログの参照"] } }] };
      if (action.lifelogPageIds?.length) props["参照元lifelog"] = { relation: action.lifelogPageIds.map((id) => ({ id })) };

      const page = await createPage(process.env.IDENTITY_DB_ID!, props, "");
      createdIdentityUrls.push(pageUrl(page));
    } else if (action.type === "update") {
      const props: Record<string, unknown> = { "最終更新日": { date: { start: today } } };
      if (action.updates["ステータス"]) {
        props["ステータス"] = { status: { name: action.updates["ステータス"] } };
        props["変更日"] = { date: { start: today } };
      }
      if (action.updates["変更理由"]) props["変更理由"] = { rich_text: [{ text: { content: action.updates["変更理由"] } }] };
      if (action.updates["詳細説明"]) props["詳細説明"] = { rich_text: [{ text: { content: action.updates["詳細説明"] } }] };
      await updatePage(action.pageId, props);
    }
  }

  for (const action of result.decisionActions) {
    if (action.type === "create") {
      const props: Record<string, unknown> = {
        "意思決定内容": { title: [{ text: { content: action["意思決定内容"] } }] },
        "結果": { select: { name: "未評価" } },
        "ステータス": { status: { name: "現行" } },
      };
      if (action["決定日"]) props["決定日"] = { date: { start: action["決定日"] } };
      if (action["意思決定の種類"]) props["意思決定の種類"] = { select: { name: action["意思決定の種類"] } };
      if (action["根拠"]) props["根拠"] = { rich_text: [{ text: { content: action["根拠"] } }] };
      if (action["代替案"]) props["代替案"] = { rich_text: [{ text: { content: action["代替案"] } }] };
      if (action["リスク"]) props["リスク"] = { rich_text: [{ text: { content: action["リスク"] } }] };
      if (action["元ログの参照"]) props["元ログの参照"] = { rich_text: [{ text: { content: action["元ログの参照"] } }] };
      if (action.lifelogPageIds?.length) props["参照元lifelog"] = { relation: action.lifelogPageIds.map((id) => ({ id })) };

      const page = await createPage(process.env.DECISIONS_DB_ID!, props, "");
      createdDecisionUrls.push(pageUrl(page));
    } else if (action.type === "update") {
      const props: Record<string, unknown> = {};
      if (action.updates["ステータス"]) props["ステータス"] = { status: { name: action.updates["ステータス"] } };
      if (Object.keys(props).length > 0) await updatePage(action.pageId, props);
    }
  }

  const { newIdentity, newDecisions, updatedIdentity, updatedDecisions } = result.summary;

  const logContent = `対象期間：${start} 〜 ${end}

## 抽出結果

- 新規Identity：${newIdentity}件
- 新規Decisions：${newDecisions}件
- 既存Identity更新：${updatedIdentity}件
- 既存Decisionsステータス変更：${updatedDecisions}件

## 詳細

- identity: ${createdIdentityUrls.join(", ") || "（なし）"}
- decisions: ${createdDecisionUrls.join(", ") || "（なし）"}`;

  await logToSystemLogs({
    title: "週次Identity抽出AI 実行完了",
    level: "INFO",
    content: logContent,
    relatedDbs: ["lifelog", "identity", "decisions"],
    source: SOURCE,
  });
}

main().catch(async (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  await logToSystemLogs({
    title: "週次Identity抽出AI 実行失敗",
    level: "ERROR",
    content: message,
    relatedDbs: ["lifelog", "identity", "decisions"],
    source: SOURCE,
  }).catch(() => {});
  console.error(message);
  process.exit(1);
});
