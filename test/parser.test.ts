import { describe, it, expect } from "vitest";
import { parseTweetResult, parseBookmarks } from "../src/model/parser";

// --- fixture builder --------------------------------------------------------

interface TweetOpts {
  id: string;
  full_text?: string;
  note?: string;
  name?: string;
  handle?: string;
  media?: any[];
  quoted?: any;
  card?: any;
  urls?: any[];
}

function tweet(o: TweetOpts): any {
  const core: any = {
    rest_id: o.id,
    core: {
      user_results: {
        result: {
          legacy: {
            name: o.name ?? "Alice",
            screen_name: o.handle ?? "alice",
            profile_image_url_https: "https://pbs.twimg.com/avatar.jpg",
          },
        },
      },
    },
    legacy: {
      id_str: o.id,
      full_text: o.full_text ?? "",
      created_at: "Wed Oct 10 20:19:24 +0000 2018",
    },
  };
  if (o.note) core.note_tweet = { note_tweet_results: { result: { text: o.note } } };
  if (o.media) core.legacy.extended_entities = { media: o.media };
  if (o.quoted) core.quoted_status_result = { result: o.quoted };
  if (o.card) core.card = o.card;
  if (o.urls) core.legacy.entities = { urls: o.urls };
  return core;
}

const photo = { type: "photo", media_url_https: "https://pbs.twimg.com/p.jpg" };
const video = {
  type: "video",
  media_url_https: "https://pbs.twimg.com/thumb.jpg",
  video_info: {
    variants: [
      { content_type: "video/mp4", bitrate: 256000, url: "https://video/low.mp4" },
      { content_type: "video/mp4", bitrate: 2176000, url: "https://video/high.mp4" },
      { content_type: "application/x-mpegURL", url: "https://video/playlist.m3u8" },
    ],
  },
};
const gif = {
  type: "animated_gif",
  video_info: { variants: [{ content_type: "video/mp4", url: "https://video/g.mp4" }] },
};

// --- tests ------------------------------------------------------------------

describe("standard tweet", () => {
  it("parses author, created_at, permalink, and text", () => {
    const b = parseTweetResult(tweet({ id: "123", full_text: "hello world" }))!;
    expect(b.tweetId).toBe("123");
    expect(b.text).toBe("hello world");
    expect(b.author).toEqual({
      name: "Alice",
      handle: "alice",
      avatar: "https://pbs.twimg.com/avatar.jpg",
    });
    expect(b.permalink).toBe("https://x.com/alice/status/123");
    expect(b.createdAt).toBe("Wed Oct 10 20:19:24 +0000 2018");
  });
});

describe("long tweet", () => {
  it("prefers full note_tweet text over truncated legacy text", () => {
    const long = "x".repeat(500);
    const b = parseTweetResult(tweet({ id: "1", full_text: "x".repeat(280) + "…", note: long }))!;
    expect(b.text).toBe(long);
  });
});

describe("media", () => {
  it("parses a photo", () => {
    const b = parseTweetResult(tweet({ id: "1", media: [photo] }))!;
    expect(b.media).toEqual([
      { type: "photo", url: "https://pbs.twimg.com/p.jpg", remoteUrl: "https://pbs.twimg.com/p.jpg" },
    ]);
  });

  it("picks the highest-bitrate mp4 for video", () => {
    const b = parseTweetResult(tweet({ id: "1", media: [video] }))!;
    expect(b.media).toEqual([
      { type: "video", url: "https://video/high.mp4", remoteUrl: "https://video/high.mp4" },
    ]);
  });

  it("parses a gif as type gif", () => {
    const b = parseTweetResult(tweet({ id: "1", media: [gif] }))!;
    expect(b.media[0].type).toBe("gif");
    expect(b.media[0].url).toBe("https://video/g.mp4");
  });

  it("handles multiple media items", () => {
    const b = parseTweetResult(tweet({ id: "1", media: [photo, video] }))!;
    expect(b.media.map((m) => m.type)).toEqual(["photo", "video"]);
  });
});

describe("quoted tweet", () => {
  it("recurses one level", () => {
    const inner = tweet({ id: "999", full_text: "quoted text", handle: "bob", name: "Bob" });
    const b = parseTweetResult(tweet({ id: "1", full_text: "outer", quoted: inner }))!;
    expect(b.quoted).not.toBeNull();
    expect(b.quoted!.tweetId).toBe("999");
    expect(b.quoted!.text).toBe("quoted text");
    expect(b.quoted!.author.handle).toBe("bob");
  });

  it("does not follow nesting deeper than one level", () => {
    const deepest = tweet({ id: "3", full_text: "deepest" });
    const middle = tweet({ id: "2", full_text: "middle", quoted: deepest });
    const b = parseTweetResult(tweet({ id: "1", full_text: "top", quoted: middle }))!;
    expect(b.quoted!.tweetId).toBe("2");
    expect(b.quoted!.quoted).toBeNull();
  });
});

describe("card", () => {
  it("extracts title/description/thumb and the expanded url", () => {
    const card = {
      legacy: {
        url: "https://t.co/abc",
        binding_values: [
          { key: "title", value: { string_value: "Example Title" } },
          { key: "description", value: { string_value: "A description" } },
          { key: "thumbnail_image_original", value: { image_value: { url: "https://pbs.twimg.com/card.jpg" } } },
        ],
      },
    };
    const b = parseTweetResult(
      tweet({ id: "1", card, urls: [{ expanded_url: "https://example.com/article" }] })
    )!;
    expect(b.card).toEqual({
      title: "Example Title",
      desc: "A description",
      thumb: "https://pbs.twimg.com/card.jpg",
      url: "https://example.com/article",
    });
  });
});

describe("fault tolerance", () => {
  it("returns null for a tombstone (deleted/unavailable)", () => {
    expect(parseTweetResult({ __typename: "TweetTombstone" })).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(parseTweetResult(null)).toBeNull();
    expect(parseTweetResult({})).toBeNull();
    expect(parseTweetResult({ legacy: {} })).toBeNull(); // no id
  });

  it("parseBookmarks skips bad entries and keeps good ones", () => {
    const good = tweet({ id: "1", full_text: "ok" });
    const out = parseBookmarks([good, { __typename: "TweetTombstone" }, null, tweet({ id: "2" })]);
    expect(out.map((b) => b.tweetId)).toEqual(["1", "2"]);
  });

  it("text-only tweet (no media) parses with empty media array", () => {
    const b = parseTweetResult(tweet({ id: "1", full_text: "just text" }))!;
    expect(b.media).toEqual([]);
    expect(b.card).toBeNull();
    expect(b.quoted).toBeNull();
  });
});
