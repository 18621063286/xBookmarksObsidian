import { asArray, asString, dig, get, isObject } from "../util/json";

/**
 * Walk an X `bookmark_timeline_v2` GraphQL response down to its tweet entries and
 * pagination cursors. Pure and defensive — shared by the pagination loop (U3, for
 * no-progress detection) and the rich parser (U5). Never throws on shape drift;
 * returns empties instead so one bad page can't crash a whole sync.
 */

export interface TweetEntry {
  /** Stable tweet id (rest_id / id_str), used for dedup + no-progress checks. */
  id: string;
  /** The `tweet_results.result` object for downstream rich parsing. */
  result: unknown;
}

export interface TimelineExtract {
  tweetEntries: TweetEntry[];
  bottomCursor: string | null;
  topCursor: string | null;
}

function getTweetId(result: unknown): string | null {
  if (!isObject(result)) return null;
  // TweetWithVisibilityResults wraps the real tweet under `.tweet`.
  const core = isObject(result.tweet) ? result.tweet : result;
  return asString(get(core, "rest_id")) ?? asString(dig(core, "legacy", "id_str")) ?? null;
}

function getTweetResult(entryContent: unknown): unknown {
  return dig(entryContent, "itemContent", "tweet_results", "result") ?? null;
}

export function extractTimelineEntries(json: unknown): TimelineExtract {
  const out: TimelineExtract = { tweetEntries: [], bottomCursor: null, topCursor: null };

  const instructions =
    dig(json, "data", "bookmark_timeline_v2", "timeline", "instructions") ??
    dig(json, "data", "bookmark_timeline", "timeline", "instructions");

  for (const instruction of asArray(instructions)) {
    const entries = get(instruction, "entries");
    if (!Array.isArray(entries)) {
      // TimelineReplaceEntry carries a single `entry` (often a cursor).
      const single = get(instruction, "entry");
      if (single) collectEntry(single, out);
      continue;
    }
    for (const entry of entries) collectEntry(entry, out);
  }

  return out;
}

function collectEntry(entry: unknown, out: TimelineExtract): void {
  const content = get(entry, "content");
  if (!isObject(content)) return;
  const entryId = asString(get(entry, "entryId")) ?? "";

  // Cursor entries.
  const entryType = asString(content.entryType);
  const typename = asString(content.__typename);
  if (entryType === "TimelineTimelineCursor" || typename === "TimelineTimelineCursor") {
    const type = asString(content.cursorType);
    const value = asString(content.value);
    if (type === "Bottom" || entryId.startsWith("cursor-bottom")) out.bottomCursor = value ?? out.bottomCursor;
    else if (type === "Top" || entryId.startsWith("cursor-top")) out.topCursor = value ?? out.topCursor;
    return;
  }

  // Tweet item entries.
  if (entryType === "TimelineTimelineItem" || entryId.startsWith("tweet-")) {
    const result = getTweetResult(content);
    const id = getTweetId(result) ?? idFromEntryId(entryId);
    if (id && result) out.tweetEntries.push({ id, result });
  }

  // Modules (e.g. conversation) — scan nested items defensively.
  const items = content.items;
  if (Array.isArray(items)) {
    for (const it of items) {
      const result = getTweetResult(get(it, "item"));
      const id = getTweetId(result);
      if (id && result) out.tweetEntries.push({ id, result });
    }
  }
}

function idFromEntryId(entryId: string): string | null {
  const m = entryId.match(/^tweet-(\d+)/);
  return m ? m[1] : null;
}
