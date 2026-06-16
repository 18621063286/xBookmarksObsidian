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
  result: any;
}

export interface TimelineExtract {
  tweetEntries: TweetEntry[];
  bottomCursor: string | null;
  topCursor: string | null;
}

function getTweetId(result: any): string | null {
  if (!result) return null;
  // TweetWithVisibilityResults wraps the real tweet under `.tweet`.
  const core = result.tweet ?? result;
  return core?.rest_id ?? core?.legacy?.id_str ?? null;
}

function getTweetResult(entryContent: any): any | null {
  const tr = entryContent?.itemContent?.tweet_results?.result;
  return tr ?? null;
}

export function extractTimelineEntries(json: any): TimelineExtract {
  const out: TimelineExtract = { tweetEntries: [], bottomCursor: null, topCursor: null };

  const instructions =
    json?.data?.bookmark_timeline_v2?.timeline?.instructions ??
    json?.data?.bookmark_timeline?.timeline?.instructions ??
    [];

  if (!Array.isArray(instructions)) return out;

  for (const instruction of instructions) {
    const entries = instruction?.entries;
    if (!Array.isArray(entries)) {
      // TimelineReplaceEntry carries a single `entry` (often a cursor).
      if (instruction?.entry) collectEntry(instruction.entry, out);
      continue;
    }
    for (const entry of entries) collectEntry(entry, out);
  }

  return out;
}

function collectEntry(entry: any, out: TimelineExtract): void {
  const content = entry?.content;
  if (!content) return;
  const entryId: string = entry.entryId ?? "";

  // Cursor entries.
  if (content.entryType === "TimelineTimelineCursor" || content.__typename === "TimelineTimelineCursor") {
    const type = content.cursorType;
    if (type === "Bottom" || entryId.startsWith("cursor-bottom")) out.bottomCursor = content.value ?? out.bottomCursor;
    else if (type === "Top" || entryId.startsWith("cursor-top")) out.topCursor = content.value ?? out.topCursor;
    return;
  }

  // Tweet item entries.
  if (content.entryType === "TimelineTimelineItem" || entryId.startsWith("tweet-")) {
    const result = getTweetResult(content);
    const id = getTweetId(result) ?? idFromEntryId(entryId);
    if (id && result) out.tweetEntries.push({ id, result });
  }

  // Modules (e.g. conversation) — scan nested items defensively.
  const items = content?.items;
  if (Array.isArray(items)) {
    for (const it of items) {
      const result = getTweetResult(it?.item);
      const id = getTweetId(result);
      if (id && result) out.tweetEntries.push({ id, result });
    }
  }
}

function idFromEntryId(entryId: string): string | null {
  const m = entryId.match(/^tweet-(\d+)/);
  return m ? m[1] : null;
}
