import { describe, it, expect } from "vitest";
import {
  toMonth,
  bookmarkToRecord,
  addRecords,
  topAuthors,
  buildMonthPrompt,
  renderMonthSection,
  parseDigestSections,
  mergeDigest,
  type DigestStore,
  type DigestRecord,
} from "../src/ai/digest";
import type { Bookmark } from "../src/model/types";

function rec(over: Partial<DigestRecord> = {}): DigestRecord {
  return {
    tweetId: "1",
    month: "2024-06",
    createdAt: "Wed Jun 12 20:19:24 +0000 2024",
    name: "Alice",
    handle: "alice",
    url: "https://x.com/alice/status/1",
    text: "hello",
    ...over,
  };
}

describe("toMonth", () => {
  it("derives YYYY-MM from a tweet date", () => {
    expect(toMonth("Wed Jun 12 20:19:24 +0000 2024")).toBe("2024-06");
    expect(toMonth("Wed Oct 10 20:19:24 +0000 2018")).toBe("2018-10");
  });
  it("returns 'unknown' for unparseable input", () => {
    expect(toMonth("")).toBe("unknown");
    expect(toMonth("nope")).toBe("unknown");
  });
});

describe("bookmarkToRecord", () => {
  const b: Bookmark = {
    tweetId: "9",
    text: "main text",
    author: { name: "Bob", handle: "bob", avatar: "" },
    createdAt: "Wed Jun 12 20:19:24 +0000 2024",
    permalink: "https://x.com/bob/status/9",
    media: [],
    quoted: {
      tweetId: "8",
      text: "quoted text",
      author: { name: "Cara", handle: "cara", avatar: "" },
      createdAt: "",
      permalink: "",
      media: [],
      quoted: null,
      card: null,
    },
    card: null,
  };
  it("maps fields and folds in the quoted text", () => {
    const r = bookmarkToRecord(b);
    expect(r.month).toBe("2024-06");
    expect(r.handle).toBe("bob");
    expect(r.url).toBe("https://x.com/bob/status/9");
    expect(r.text).toContain("main text");
    expect(r.text).toContain("quoted text");
    expect(r.text).toContain("@cara");
  });
});

describe("addRecords", () => {
  it("adds records under their month and reports touched months", () => {
    const store: DigestStore = {};
    const touched = addRecords(store, [rec({ tweetId: "1" }), rec({ tweetId: "2", month: "2024-07" })]);
    expect([...touched].sort()).toEqual(["2024-06", "2024-07"]);
    expect(store["2024-06"]).toHaveLength(1);
    expect(store["2024-07"]).toHaveLength(1);
  });
  it("de-dupes by tweetId within a month (replaces)", () => {
    const store: DigestStore = {};
    addRecords(store, [rec({ tweetId: "1", text: "old" })]);
    addRecords(store, [rec({ tweetId: "1", text: "new" })]);
    expect(store["2024-06"]).toHaveLength(1);
    expect(store["2024-06"][0].text).toBe("new");
  });
});

describe("topAuthors", () => {
  it("counts and ranks authors", () => {
    const records = [rec({ handle: "a" }), rec({ handle: "a" }), rec({ handle: "b" })];
    const top = topAuthors(records, 5);
    expect(top[0]).toEqual({ handle: "a", name: "Alice", count: 2 });
    expect(top[1].handle).toBe("b");
  });
});

describe("buildMonthPrompt", () => {
  it("includes the month and the bookmark lines", () => {
    const p = buildMonthPrompt("2024-06", [rec({ handle: "alice", text: "about AI" })]);
    expect(p).toContain("2024-06");
    expect(p).toContain("@alice");
    expect(p).toContain("about AI");
    expect(p).toContain("主要话题");
  });
});

describe("renderMonthSection", () => {
  it("renders heading, count, author line and collapsible list", () => {
    const section = renderMonthSection("2024-06", [rec({ handle: "alice" })], "**主要话题**：AI");
    expect(section).toMatch(/^## 2024-06 · 1 条/);
    expect(section).toContain("**主要话题**：AI");
    expect(section).toContain("@alice");
    expect(section).toContain("<details>");
    expect(section).toContain("[原文](https://x.com/alice/status/1)");
  });

  it("neutralizes markdown/HTML in embedded tweet text (no code fences, angle brackets, or fake links)", () => {
    const evil = rec({ text: "prompt: ``` code ``` and </details> and [fake](x)" });
    const section = renderMonthSection("2024-06", [evil], "body");
    expect(section).not.toContain("```");
    expect(section).not.toContain("</details> and"); // the tweet's </details> must be defused
    // the real footer link is still intact
    expect(section).toContain("[原文](https://x.com/alice/status/1)");
    // exactly one real <details>/</details> pair
    expect((section.match(/<details>/g) || []).length).toBe(1);
    expect((section.match(/<\/details>/g) || []).length).toBe(1);
  });

  it("strips a code fence the model wrapped the whole answer in", () => {
    const section = renderMonthSection("2024-06", [rec()], "```markdown\n**主要话题**：X\n```");
    expect(section).toContain("**主要话题**：X");
    expect(section).not.toContain("```");
  });
});

describe("parseDigestSections + mergeDigest", () => {
  it("parses month sections from an existing digest", () => {
    const content = `# Title\n\n> meta\n\n## 2024-07 · 1 条\nA\n\n## 2024-06 · 2 条\nB`;
    const map = parseDigestSections(content);
    expect([...map.keys()].sort()).toEqual(["2024-06", "2024-07"]);
    expect(map.get("2024-06")).toContain("B");
  });

  it("merges newest-first, replacing matching months and keeping others", () => {
    const existing = `# X\n\n> old\n\n## 2024-06 · 1 条\nold June`;
    const merged = mergeDigest(
      existing,
      [
        { month: "2024-07", content: "## 2024-07 · 1 条\nnew July" },
        { month: "2024-06", content: "## 2024-06 · 2 条\nnew June" },
      ],
      { title: "X Digest", model: "llama3", updatedAt: "2026-06-16T00:00:00Z" }
    );
    // newest month first
    expect(merged.indexOf("2024-07")).toBeLessThan(merged.indexOf("2024-06"));
    // June replaced, not duplicated
    expect(merged).toContain("new June");
    expect(merged).not.toContain("old June");
    expect((merged.match(/## 2024-06/g) || []).length).toBe(1);
    // header regenerated
    expect(merged).toContain("# X Digest");
    expect(merged).toContain("llama3");
  });

  it("sorts 'unknown' last", () => {
    const merged = mergeDigest(
      "",
      [
        { month: "unknown", content: "## unknown · 1 条\nU" },
        { month: "2024-06", content: "## 2024-06 · 1 条\nJ" },
      ],
      { title: "T", model: "m", updatedAt: "t" }
    );
    expect(merged.indexOf("2024-06")).toBeLessThan(merged.indexOf("unknown"));
  });
});
