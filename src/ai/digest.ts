import type { Bookmark } from "../model/types";

/**
 * Pure digest logic (no Obsidian/network): group bookmarks by month, build the
 * Ollama prompt, render a month section, and merge sections into the digest file
 * (newest month on top). All testable in isolation.
 */

export interface DigestRecord {
  tweetId: string;
  month: string; // "YYYY-MM" or "unknown"
  createdAt: string;
  name: string;
  handle: string;
  url: string;
  text: string;
}

export type DigestStore = Record<string, DigestRecord[]>; // month -> records

const MONTHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

export function toMonth(createdAt: string): string {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return "unknown";
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${MONTHS[d.getUTCMonth()]}`;
}

function clamp(s: string, n: number): string {
  const oneLine = (s || "").replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}

export function bookmarkToRecord(b: Bookmark): DigestRecord {
  let text = b.text;
  if (b.quoted?.text) text += ` ｜引用 @${b.quoted.author.handle}：${b.quoted.text}`;
  return {
    tweetId: b.tweetId,
    month: toMonth(b.createdAt),
    createdAt: b.createdAt,
    name: b.author.name,
    handle: b.author.handle,
    url: b.permalink,
    text: clamp(text, 600),
  };
}

/** Add/replace records in the store, de-duped by tweetId within each month. */
export function addRecords(store: DigestStore, records: DigestRecord[]): Set<string> {
  const touched = new Set<string>();
  for (const r of records) {
    const list = store[r.month] ?? (store[r.month] = []);
    const i = list.findIndex((x) => x.tweetId === r.tweetId);
    if (i === -1) list.push(r);
    else list[i] = r;
    touched.add(r.month);
  }
  return touched;
}

export function topAuthors(records: DigestRecord[], n: number): { handle: string; name: string; count: number }[] {
  const by = new Map<string, { handle: string; name: string; count: number }>();
  for (const r of records) {
    const key = r.handle || r.name;
    const e = by.get(key) ?? { handle: r.handle, name: r.name, count: 0 };
    e.count++;
    by.set(key, e);
  }
  return [...by.values()].sort((a, b) => b.count - a.count).slice(0, n);
}

const MAX_PROMPT_ITEMS = 120;
const ITEM_TEXT_LEN = 240;

/** Build the Chinese summarization prompt for one month's bookmarks. */
export function buildMonthPrompt(month: string, records: DigestRecord[]): string {
  const items = records.slice(0, MAX_PROMPT_ITEMS);
  const lines = items.map((r, i) => `${i + 1}. @${r.handle}（${r.name}）：${clamp(r.text, ITEM_TEXT_LEN)}`);
  const more = records.length > items.length ? `\n（本月共 ${records.length} 条，仅展示前 ${items.length} 条）` : "";
  return [
    `你是我的个人知识助理。下面是我在 ${month} 这一时期收藏的 Twitter/X 推文清单。`,
    `请用简体中文，基于这些推文，输出一段简洁的月度小结，严格使用以下 Markdown 结构（不要添加额外标题、不要寒暄、不要逐条复述）：`,
    ``,
    `**主要话题**：用 3-6 个要点概括这个月收藏内容的核心主题。`,
    `**核心观点**：用 3-5 个要点列出其中值得记住的观点或结论。`,
    `**一句话概括**：用一句话总结这个月我主要在关注什么。`,
    ``,
    `推文清单：`,
    lines.join("\n"),
    more,
  ].join("\n");
}

/** Render one month's full section (heading + stats + AI body + collapsible list). */
export function renderMonthSection(month: string, records: DigestRecord[], aiBody: string): string {
  const authors = topAuthors(records, 6)
    .map((a) => `@${a.handle}（${a.count}）`)
    .join("、");
  const list = records
    .map((r) => `- **${r.name} (@${r.handle})**：${clamp(r.text, 140)} — [原文](${r.url})`)
    .join("\n");

  return [
    `## ${month} · ${records.length} 条`,
    ``,
    aiBody.trim(),
    ``,
    `**主要作者**：${authors || "—"}`,
    ``,
    `<details>`,
    `<summary>本月书签清单（${records.length}）</summary>`,
    ``,
    list,
    ``,
    `</details>`,
  ].join("\n");
}

export interface DigestMeta {
  title: string;
  model: string;
  updatedAt: string; // ISO
}

const HEADING_RE = /^##\s+(\d{4}-\d{2}|unknown)\b/;

/** Parse an existing digest file into month -> section text (incl. heading). */
export function parseDigestSections(content: string): Map<string, string> {
  const map = new Map<string, string>();
  let cur: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (cur) map.set(cur, buf.join("\n").trim());
  };
  for (const line of (content || "").split("\n")) {
    const m = line.match(HEADING_RE);
    if (m) {
      flush();
      cur = m[1];
      buf = [line];
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return map;
}

function monthSortDesc(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "unknown") return 1;
  if (b === "unknown") return -1;
  return b.localeCompare(a);
}

/**
 * Merge regenerated month sections into the existing digest, replacing matching
 * months and inserting new ones, sorted newest-first, under a fresh header.
 */
export function mergeDigest(
  existing: string,
  sections: { month: string; content: string }[],
  meta: DigestMeta
): string {
  const map = parseDigestSections(existing);
  for (const s of sections) map.set(s.month, s.content.trim());

  const months = [...map.keys()].sort(monthSortDesc);
  const header = [
    `# ${meta.title}`,
    ``,
    `> 由本地 Ollama（${meta.model || "未指定模型"}）自动生成 · 最近更新：${meta.updatedAt}`,
  ].join("\n");

  return [header, ...months.map((m) => map.get(m)!)].join("\n\n") + "\n";
}
