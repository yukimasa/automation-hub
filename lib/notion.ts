import { Client } from "@notionhq/client";
import type {
  BlockObjectRequest,
  PageObjectResponse,
  QueryDatabaseParameters,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints.js";

let _client: Client | null = null;

function getClient(): Client {
  if (!_client) {
    _client = new Client({ auth: process.env.NOTION_TOKEN });
  }
  return _client;
}

function richTextToPlain(rich: RichTextItemResponse[]): string {
  return rich.map((r) => r.plain_text).join("");
}

export async function getPageMarkdown(pageId: string): Promise<string> {
  const notion = getClient();
  const lines: string[] = [];
  let cursor: string | undefined;

  do {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const block of res.results) {
      if (!("type" in block)) continue;
      switch (block.type) {
        case "heading_1":
          lines.push(`# ${richTextToPlain(block.heading_1.rich_text)}`);
          break;
        case "heading_2":
          lines.push(`## ${richTextToPlain(block.heading_2.rich_text)}`);
          break;
        case "heading_3":
          lines.push(`### ${richTextToPlain(block.heading_3.rich_text)}`);
          break;
        case "paragraph":
          lines.push(richTextToPlain(block.paragraph.rich_text));
          break;
        case "bulleted_list_item":
          lines.push(`- ${richTextToPlain(block.bulleted_list_item.rich_text)}`);
          break;
        case "numbered_list_item":
          lines.push(`1. ${richTextToPlain(block.numbered_list_item.rich_text)}`);
          break;
        case "quote":
          lines.push(`> ${richTextToPlain(block.quote.rich_text)}`);
          break;
      }
    }

    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return lines.join("\n");
}

export async function queryDatabase(
  dbId: string,
  filter?: QueryDatabaseParameters["filter"],
  sorts?: QueryDatabaseParameters["sorts"]
): Promise<PageObjectResponse[]> {
  const notion = getClient();
  const pages: PageObjectResponse[] = [];
  let cursor: string | undefined;

  do {
    const res = await notion.databases.query({
      database_id: dbId,
      filter,
      sorts,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of res.results) {
      if ("properties" in page) pages.push(page as PageObjectResponse);
    }

    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return pages;
}

export async function createPage(
  dbId: string,
  properties: Record<string, unknown>,
  markdownBody: string
): Promise<PageObjectResponse> {
  const notion = getClient();
  const children = markdownToBlocks(markdownBody);

  const MAX_BLOCKS = 100;
  const firstBatch = children.slice(0, MAX_BLOCKS);

  const page = await notion.pages.create({
    parent: { database_id: dbId },
    properties: properties as Parameters<typeof notion.pages.create>[0]["properties"],
    children: firstBatch,
  });

  for (let i = MAX_BLOCKS; i < children.length; i += MAX_BLOCKS) {
    await notion.blocks.children.append({
      block_id: page.id,
      children: children.slice(i, i + MAX_BLOCKS),
    });
  }

  return page as PageObjectResponse;
}

function richText(text: string, bold = false, italic = false) {
  return [{ type: "text" as const, text: { content: text }, annotations: { bold, italic, strikethrough: false, underline: false, code: false, color: "default" as const } }];
}

function parseInline(raw: string) {
  const result: ReturnType<typeof richText> = [];
  const re = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_)/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) result.push(...richText(raw.slice(last, m.index)));
    if (m[2]) result.push(...richText(m[2], true, true));
    else if (m[3]) result.push(...richText(m[3], true, false));
    else if (m[4]) result.push(...richText(m[4], false, true));
    else if (m[5]) result.push(...richText(m[5], false, true));
    last = m.index + m[0].length;
  }

  if (last < raw.length) result.push(...richText(raw.slice(last)));
  return result;
}

export function markdownToBlocks(md: string): BlockObjectRequest[] {
  const blocks: BlockObjectRequest[] = [];
  const lines = md.split("\n");

  for (const line of lines) {
    if (line.startsWith("### ")) {
      blocks.push({ type: "heading_3", heading_3: { rich_text: parseInline(line.slice(4)) } });
    } else if (line.startsWith("## ")) {
      blocks.push({ type: "heading_2", heading_2: { rich_text: parseInline(line.slice(3)) } });
    } else if (line.startsWith("# ")) {
      blocks.push({ type: "heading_1", heading_1: { rich_text: parseInline(line.slice(2)) } });
    } else if (/^  - /.test(line)) {
      blocks.push({ type: "bulleted_list_item", bulleted_list_item: { rich_text: parseInline(line.slice(4)) } });
    } else if (/^- /.test(line)) {
      blocks.push({ type: "bulleted_list_item", bulleted_list_item: { rich_text: parseInline(line.slice(2)) } });
    } else if (/^  \d+\. /.test(line)) {
      blocks.push({ type: "numbered_list_item", numbered_list_item: { rich_text: parseInline(line.replace(/^\s+\d+\. /, "")) } });
    } else if (/^\d+\. /.test(line)) {
      blocks.push({ type: "numbered_list_item", numbered_list_item: { rich_text: parseInline(line.replace(/^\d+\. /, "")) } });
    } else if (line.trim() !== "") {
      blocks.push({ type: "paragraph", paragraph: { rich_text: parseInline(line) } });
    }
  }

  return blocks;
}
