import type { Bookmark, BookmarkAuthor, BookmarkCard, BookmarkMedia, MediaType } from "./types";

/**
 * Parse an X `tweet_results.result` object into the stable Bookmark model (R4/KTD6).
 *
 * Captures: full text (note_tweet long-form preferred, legacy.full_text fallback),
 * author, created_at, permalink, media (photo / highest-bitrate video / gif),
 * one level of quoted tweet, and external-link card. Threads are NOT reconstructed.
 *
 * Every accessor is defensive: a malformed or unavailable entry yields null and is
 * skipped, so one bad bookmark never crashes a whole sync.
 */

const MAX_QUOTE_DEPTH = 1;

export function parseTweetResult(result: any, depth = 0): Bookmark | null {
  try {
    const core = unwrap(result);
    if (!core) return null;

    const legacy = core.legacy ?? {};
    const tweetId: string | undefined = core.rest_id ?? legacy.id_str;
    if (!tweetId) return null;

    const author = parseAuthor(core);
    const text = parseText(core, legacy);
    const createdAt: string = legacy.created_at ?? "";
    const permalink = author.handle
      ? `https://x.com/${author.handle}/status/${tweetId}`
      : `https://x.com/i/status/${tweetId}`;

    const media = parseMedia(legacy);
    const card = parseCard(core, legacy);

    let quoted: Bookmark | null = null;
    if (depth < MAX_QUOTE_DEPTH) {
      const quotedResult = core.quoted_status_result?.result;
      if (quotedResult) quoted = parseTweetResult(quotedResult, depth + 1);
    }

    return { tweetId, text, author, createdAt, permalink, media, quoted, card };
  } catch {
    return null;
  }
}

/** Parse a list of tweet results, skipping any that fail to parse. */
export function parseBookmarks(results: any[]): Bookmark[] {
  const out: Bookmark[] = [];
  for (const r of results ?? []) {
    const b = parseTweetResult(r);
    if (b) out.push(b);
  }
  return out;
}

// --- helpers ----------------------------------------------------------------

/** Unwrap visibility wrappers / tombstones to the underlying tweet object. */
function unwrap(result: any): any | null {
  if (!result) return null;
  if (result.__typename === "TweetTombstone") return null;
  // TweetWithVisibilityResults nests the real tweet under `.tweet`.
  const core = result.tweet ?? result;
  if (!core || (!core.rest_id && !core.legacy)) return null;
  return core;
}

function parseAuthor(core: any): BookmarkAuthor {
  const user = core.core?.user_results?.result ?? {};
  const uLegacy = user.legacy ?? {};
  const uCore = user.core ?? {};
  return {
    name: uLegacy.name ?? uCore.name ?? "",
    handle: uLegacy.screen_name ?? uCore.screen_name ?? "",
    avatar: uLegacy.profile_image_url_https ?? user.avatar?.image_url ?? "",
  };
}

function parseText(core: any, legacy: any): string {
  const note = core.note_tweet?.note_tweet_results?.result?.text;
  if (typeof note === "string" && note.length > 0) return note;
  return legacy.full_text ?? legacy.text ?? "";
}

function parseMedia(legacy: any): BookmarkMedia[] {
  const raw = legacy.extended_entities?.media ?? legacy.entities?.media ?? [];
  const out: BookmarkMedia[] = [];
  for (const m of raw) {
    const item = parseMediaItem(m);
    if (item) out.push(item);
  }
  return out;
}

function parseMediaItem(m: any): BookmarkMedia | null {
  if (!m) return null;
  if (m.type === "photo") {
    const url = m.media_url_https ?? m.media_url;
    return url ? { type: "photo", url, remoteUrl: url } : null;
  }
  if (m.type === "video" || m.type === "animated_gif") {
    const url = pickVideoUrl(m);
    if (!url) return null;
    const type: MediaType = m.type === "animated_gif" ? "gif" : "video";
    return { type, url, remoteUrl: url };
  }
  return null;
}

function pickVideoUrl(m: any): string {
  const variants: any[] = m.video_info?.variants ?? [];
  const mp4 = variants
    .filter((v) => v.content_type === "video/mp4" && typeof v.bitrate === "number")
    .sort((a, b) => b.bitrate - a.bitrate);
  if (mp4.length > 0) return mp4[0].url;
  const any = variants.find((v) => v.url);
  return any?.url ?? m.media_url_https ?? "";
}

function parseCard(core: any, legacy: any): BookmarkCard | null {
  const card = core.card ?? legacy.card;
  const bindings: any[] = card?.legacy?.binding_values ?? card?.binding_values ?? [];
  if (!bindings.length) return null;

  const get = (key: string): string => {
    const b = bindings.find((x) => x.key === key);
    const v = b?.value;
    if (!v) return "";
    return v.string_value ?? v.image_value?.url ?? v.scribe_key ?? "";
  };

  const title = get("title");
  const desc = get("description");
  const thumb = get("thumbnail_image_original") || get("thumbnail_image_large") || get("thumbnail_image");
  // Prefer the expanded destination URL; fall back to the card's own url.
  const expanded = legacy.entities?.urls?.[0]?.expanded_url;
  const url = expanded || get("card_url") || card?.legacy?.url || card?.url || "";

  if (!title && !desc && !url) return null;
  return { title, desc, thumb, url };
}
