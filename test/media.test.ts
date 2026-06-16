import { describe, it, expect, vi } from "vitest";
import { localizeMedia, localizeBookmarkMedia, type MediaIO } from "../src/sync/media";
import type { Bookmark, BookmarkMedia } from "../src/model/types";

function photo(url: string): BookmarkMedia {
  return { type: "photo", url, remoteUrl: url };
}

function fakeIO(over: Partial<MediaIO> = {}): MediaIO & { written: Record<string, ArrayBuffer> } {
  const written: Record<string, ArrayBuffer> = {};
  return {
    written,
    download: vi.fn(async () => new ArrayBuffer(8)),
    writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
      written[path] = data;
    }),
    exists: vi.fn(() => false),
    ensureFolder: vi.fn(async () => {}),
    warn: vi.fn(),
    ...over,
  } as any;
}

describe("localizeMedia", () => {
  it("downloads media and rewrites url to a local path", async () => {
    const io = fakeIO();
    const media = [photo("https://pbs.twimg.com/a.jpg")];
    await localizeMedia("123", media, "Twitter/_attachments", io);

    expect(io.download).toHaveBeenCalledWith("https://pbs.twimg.com/a.jpg");
    expect(media[0].url).toBe("Twitter/_attachments/123-0.jpg");
    // remoteUrl preserved for fallback
    expect(media[0].remoteUrl).toBe("https://pbs.twimg.com/a.jpg");
    expect(Object.keys(io.written)).toEqual(["Twitter/_attachments/123-0.jpg"]);
  });

  it("indexes multiple media items by position", async () => {
    const io = fakeIO();
    const media = [photo("https://pbs/a.jpg"), photo("https://pbs/b.jpg")];
    await localizeMedia("9", media, "att", io);
    expect(media.map((m) => m.url)).toEqual(["att/9-0.jpg", "att/9-1.jpg"]);
  });

  it("derives extension from type when url has none (video -> mp4)", async () => {
    const io = fakeIO();
    const media: BookmarkMedia[] = [
      { type: "video", url: "https://video.twimg.com/x?tag=12", remoteUrl: "https://video.twimg.com/x?tag=12" },
    ];
    await localizeMedia("7", media, "att", io);
    expect(media[0].url).toBe("att/7-0.mp4");
  });

  it("skips re-downloading when the file already exists but still rewrites url", async () => {
    const io = fakeIO({ exists: vi.fn(() => true) });
    const media = [photo("https://pbs/a.jpg")];
    await localizeMedia("123", media, "att", io);
    expect(io.download).not.toHaveBeenCalled();
    expect(media[0].url).toBe("att/123-0.jpg");
  });

  it("on download failure keeps the CDN url and warns", async () => {
    const io = fakeIO({
      download: vi.fn(async () => {
        throw new Error("network");
      }),
    });
    const media = [photo("https://pbs/a.jpg")];
    await localizeMedia("123", media, "att", io);
    expect(media[0].url).toBe("https://pbs/a.jpg"); // unchanged
    expect(io.warn).toHaveBeenCalled();
  });

  it("does nothing for an empty media list", async () => {
    const io = fakeIO();
    await localizeMedia("1", [], "att", io);
    expect(io.ensureFolder).not.toHaveBeenCalled();
  });
});

describe("localizeBookmarkMedia", () => {
  it("localizes both the tweet and its quoted tweet media", async () => {
    const io = fakeIO();
    const quoted = {
      tweetId: "999",
      media: [photo("https://pbs/q.jpg")],
    } as Bookmark;
    const bookmark = {
      tweetId: "1",
      media: [photo("https://pbs/m.jpg")],
      quoted,
    } as Bookmark;

    await localizeBookmarkMedia(bookmark, "att", io);
    expect(bookmark.media[0].url).toBe("att/1-0.jpg");
    expect(bookmark.quoted!.media[0].url).toBe("att/999-0.jpg");
  });
});
