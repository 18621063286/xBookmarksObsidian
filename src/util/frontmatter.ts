import type { Bookmark } from "../model/types";

/**
 * Frontmatter is owned by the renderer (not the user template) so the dedup
 * sentinel (`doc_type` + `tweet_id`) is always present, even with a fully custom
 * body template. This is what makes "store once, never overwrite" (KTD5) robust.
 */

export interface FrontmatterData {
  doc_type: "x-bookmark";
  tweet_id: string;
  author: string;
  handle: string;
  created: string;
  url: string;
  bookmarked_at: string;
}

export function buildFrontmatter(b: Bookmark, bookmarkedAt: string): FrontmatterData {
  return {
    doc_type: "x-bookmark",
    tweet_id: b.tweetId,
    author: b.author.name,
    handle: b.author.handle,
    created: toIsoDate(b.createdAt),
    url: b.permalink,
    bookmarked_at: bookmarkedAt,
  };
}

/** Serialize to a YAML frontmatter block. String values are JSON-quoted so colons,
 *  quotes, and unicode never break the YAML (and big tweet ids stay strings). */
export function serializeFrontmatter(data: FrontmatterData): string {
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${JSON.stringify(String(v))}`);
  return `---\n${lines.join("\n")}\n---`;
}

/** Convert X's date string to ISO 8601; fall back to the original on parse failure. */
export function toIsoDate(twitterDate: string): string {
  if (!twitterDate) return "";
  const t = Date.parse(twitterDate);
  return Number.isNaN(t) ? twitterDate : new Date(t).toISOString();
}

/**
 * Note filename: `{handle}-{tweetId}.md`. Strips filesystem-illegal characters and
 * replaces block-reference-sensitive chars (`_`, `~`) with `-` so embeds/block refs
 * to these notes don't break.
 */
export function sanitizeFilename(handle: string, tweetId: string): string {
  const h = sanitizePart(handle) || "x";
  const id = sanitizePart(tweetId) || "unknown";
  return `${h}-${id}.md`;
}

function sanitizePart(s: string): string {
  return (s || "")
    .replace(/[\\/:*?"<>|#^[\]]/g, "")
    .replace(/[_~]/g, "-")
    .trim();
}
