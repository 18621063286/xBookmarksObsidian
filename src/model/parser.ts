import type { Bookmark, BookmarkAuthor, BookmarkCard, BookmarkMedia, MediaType } from "./types";
import { asArray, asNumber, asString, dig, get, isObject, type JsonObject } from "../util/json";

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

export function parseTweetResult(result: unknown, depth = 0): Bookmark | null {
  try {
    const core = unwrap(result);
    if (!core) return null;

    const legacy = isObject(core.legacy) ? core.legacy : {};
    const tweetId = asString(core.rest_id) ?? asString(legacy.id_str);
    if (!tweetId) return null;

    const author = parseAuthor(core);
    const text = parseText(core, legacy);
    const createdAt = asString(legacy.created_at) ?? "";
    const permalink = author.handle
      ? `https://x.com/${author.handle}/status/${tweetId}`
      : `https://x.com/i/status/${tweetId}`;

    const media = parseMedia(legacy);
    const card = parseCard(core, legacy);

    let quoted: Bookmark | null = null;
    if (depth < MAX_QUOTE_DEPTH) {
      const quotedResult = dig(core, "quoted_status_result", "result");
      if (quotedResult) quoted = parseTweetResult(quotedResult, depth + 1);
    }

    return { tweetId, text, author, createdAt, permalink, media, quoted, card };
  } catch {
    return null;
  }
}

/** Parse a list of tweet results, skipping any that fail to parse. */
export function parseBookmarks(results: unknown[]): Bookmark[] {
  const out: Bookmark[] = [];
  for (const r of results ?? []) {
    const b = parseTweetResult(r);
    if (b) out.push(b);
  }
  return out;
}

// --- helpers ----------------------------------------------------------------

/** Unwrap visibility wrappers / tombstones to the underlying tweet object. */
function unwrap(result: unknown): JsonObject | null {
  if (!isObject(result)) return null;
  if (result.__typename === "TweetTombstone") return null;
  // TweetWithVisibilityResults nests the real tweet under `.tweet`.
  const core = isObject(result.tweet) ? result.tweet : result;
  if (core.rest_id === undefined && core.legacy === undefined) return null;
  return core;
}

function parseAuthor(core: JsonObject): BookmarkAuthor {
  const user = dig(core, "core", "user_results", "result");
  const uLegacy = get(user, "legacy");
  const uCore = get(user, "core");
  return {
    name: asString(get(uLegacy, "name")) ?? asString(get(uCore, "name")) ?? "",
    handle: asString(get(uLegacy, "screen_name")) ?? asString(get(uCore, "screen_name")) ?? "",
    avatar: asString(get(uLegacy, "profile_image_url_https")) ?? asString(dig(user, "avatar", "image_url")) ?? "",
  };
}

function parseText(core: JsonObject, legacy: JsonObject): string {
  const note = asString(dig(core, "note_tweet", "note_tweet_results", "result", "text"));
  if (note && note.length > 0) return note;
  return asString(legacy.full_text) ?? asString(legacy.text) ?? "";
}

function parseMedia(legacy: JsonObject): BookmarkMedia[] {
  const raw = dig(legacy, "extended_entities", "media") ?? dig(legacy, "entities", "media");
  const out: BookmarkMedia[] = [];
  for (const m of asArray(raw)) {
    const item = parseMediaItem(m);
    if (item) out.push(item);
  }
  return out;
}

function parseMediaItem(m: unknown): BookmarkMedia | null {
  if (!isObject(m)) return null;
  const type = asString(m.type);
  if (type === "photo") {
    const url = asString(m.media_url_https) ?? asString(m.media_url);
    return url ? { type: "photo", url, remoteUrl: url } : null;
  }
  if (type === "video" || type === "animated_gif") {
    const url = pickVideoUrl(m);
    if (!url) return null;
    const mediaType: MediaType = type === "animated_gif" ? "gif" : "video";
    return { type: mediaType, url, remoteUrl: url };
  }
  return null;
}

function pickVideoUrl(m: JsonObject): string {
  const variants = asArray(dig(m, "video_info", "variants"));
  const mp4 = variants
    .filter((v) => asString(get(v, "content_type")) === "video/mp4" && asNumber(get(v, "bitrate")) !== undefined)
    .sort((a, b) => (asNumber(get(b, "bitrate")) ?? 0) - (asNumber(get(a, "bitrate")) ?? 0));
  const best = asString(get(mp4[0], "url"));
  if (best) return best;
  const anyVariant = variants.find((v) => asString(get(v, "url")) !== undefined);
  return asString(get(anyVariant, "url")) ?? asString(m.media_url_https) ?? "";
}

function parseCard(core: JsonObject, legacy: JsonObject): BookmarkCard | null {
  const card = isObject(core.card) ? core.card : isObject(legacy.card) ? legacy.card : undefined;
  const bindings = asArray(dig(card, "legacy", "binding_values") ?? get(card, "binding_values"));
  if (bindings.length === 0) return null;

  const read = (key: string): string => {
    const b = bindings.find((x) => asString(get(x, "key")) === key);
    const v = get(b, "value");
    return (
      asString(get(v, "string_value")) ??
      asString(dig(v, "image_value", "url")) ??
      asString(get(v, "scribe_key")) ??
      ""
    );
  };

  const title = read("title");
  const desc = read("description");
  const thumb = read("thumbnail_image_original") || read("thumbnail_image_large") || read("thumbnail_image");
  // Prefer the expanded destination URL; fall back to the card's own url.
  const urls = asArray(dig(legacy, "entities", "urls"));
  const expanded = asString(get(urls[0], "expanded_url"));
  const url =
    expanded ||
    read("card_url") ||
    asString(dig(card, "legacy", "url")) ||
    asString(get(card, "url")) ||
    "";

  if (!title && !desc && !url) return null;
  return { title, desc, thumb, url };
}
