import { describe, it, expect } from "vitest";
import { renderNote } from "../src/render/renderer";
import {
  buildFrontmatter,
  serializeFrontmatter,
  sanitizeFilename,
  toIsoDate,
} from "../src/util/frontmatter";
import type { Bookmark } from "../src/model/types";

function bookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    tweetId: "123",
    text: "hello world",
    author: { name: "Alice", handle: "alice", avatar: "https://pbs/avatar.jpg" },
    createdAt: "Wed Oct 10 20:19:24 +0000 2018",
    permalink: "https://x.com/alice/status/123",
    media: [],
    quoted: null,
    card: null,
    ...overrides,
  };
}

const AT = "2026-06-16T00:00:00.000Z";

describe("frontmatter", () => {
  it("includes the dedup sentinel and tweet_id", () => {
    const fm = serializeFrontmatter(buildFrontmatter(bookmark(), AT));
    expect(fm).toContain('doc_type: "x-bookmark"');
    expect(fm).toContain('tweet_id: "123"');
    expect(fm).toContain('url: "https://x.com/alice/status/123"');
    expect(fm.startsWith("---\n")).toBe(true);
    expect(fm.endsWith("\n---")).toBe(true);
  });

  it("quotes values so colons/unicode don't break YAML", () => {
    const fm = serializeFrontmatter(buildFrontmatter(bookmark({ author: { name: 'A: "B"', handle: "x", avatar: "" } }), AT));
    expect(fm).toContain("author: \"A: \\\"B\\\"\"");
  });

  it("normalizes created date to ISO", () => {
    expect(toIsoDate("Wed Oct 10 20:19:24 +0000 2018")).toBe("2018-10-10T20:19:24.000Z");
    expect(toIsoDate("not a date")).toBe("not a date");
  });
});

describe("renderNote", () => {
  it("renders author, text and the X permalink", () => {
    const { content } = renderNote(bookmark(), { bookmarkedAt: AT });
    expect(content).toContain("# Alice (@alice)");
    expect(content).toContain("hello world");
    expect(content).toContain("https://x.com/alice/status/123");
    // sentinel always present regardless of body
    expect(content).toContain('doc_type: "x-bookmark"');
  });

  it("renders photo media as markdown image", () => {
    const { content } = renderNote(
      bookmark({ media: [{ type: "photo", url: "https://pbs/p.jpg", remoteUrl: "https://pbs/p.jpg" }] }),
      { bookmarkedAt: AT }
    );
    expect(content).toContain("![](https://pbs/p.jpg)");
  });

  it("renders a quoted tweet block", () => {
    const { content } = renderNote(
      bookmark({
        quoted: bookmark({ tweetId: "999", text: "quoted!", author: { name: "Bob", handle: "bob", avatar: "" }, permalink: "https://x.com/bob/status/999" }),
      }),
      { bookmarkedAt: AT }
    );
    expect(content).toContain("Quoted — Bob (@bob)");
    expect(content).toContain("quoted!");
    expect(content).toContain("https://x.com/bob/status/999");
  });

  it("renders a card link", () => {
    const { content } = renderNote(
      bookmark({ card: { title: "Title", desc: "Desc", thumb: "", url: "https://example.com" } }),
      { bookmarkedAt: AT }
    );
    expect(content).toContain("[Title](https://example.com)");
    expect(content).toContain("Desc");
  });

  it("honors a custom template", () => {
    const { content } = renderNote(bookmark(), {
      bookmarkedAt: AT,
      template: "CUSTOM {{ tweet_id }} {{ author.handle }}",
    });
    expect(content).toContain("CUSTOM 123 alice");
    // frontmatter sentinel is still injected by code
    expect(content).toContain('doc_type: "x-bookmark"');
  });

  it("renders a media-only tweet (empty text) without crashing", () => {
    const { content } = renderNote(
      bookmark({ text: "", media: [{ type: "photo", url: "https://pbs/p.jpg", remoteUrl: "https://pbs/p.jpg" }] }),
      { bookmarkedAt: AT }
    );
    expect(content).toContain("![](https://pbs/p.jpg)");
  });
});

describe("sanitizeFilename", () => {
  it("builds {handle}-{id}.md", () => {
    expect(sanitizeFilename("alice", "123")).toBe("alice-123.md");
  });
  it("replaces block-sensitive and illegal chars", () => {
    expect(sanitizeFilename("a_b~c", "123")).toBe("a-b-c-123.md");
    expect(sanitizeFilename("a/b:c", "12*3")).toBe("abc-123.md");
  });
  it("falls back when handle is empty", () => {
    expect(sanitizeFilename("", "123")).toBe("x-123.md");
  });
});
