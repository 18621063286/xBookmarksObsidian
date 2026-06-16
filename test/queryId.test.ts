import { describe, it, expect, vi } from "vitest";
import {
  extractBookmarksQueryId,
  findBundleUrls,
  resolveQueryId,
  forceRefreshQueryId,
  discoverQueryId,
  STATIC_FALLBACK_QUERY_ID,
  MAX_BUNDLES_SCANNED,
} from "../src/api/queryId";

const BUNDLE_QUERYID_FIRST = `t.exports={queryId:"AbCd1234_-xy",operationName:"Bookmarks",operationType:"query",metadata:{}}`;
const BUNDLE_OPNAME_FIRST = `x={operationName:"Bookmarks",operationType:"query",queryId:"Zz99__opfirst"}`;
const BUNDLE_NO_MATCH = `e.exports={queryId:"other",operationName:"HomeTimeline"}`;

describe("extractBookmarksQueryId", () => {
  it("extracts when queryId precedes operationName", () => {
    expect(extractBookmarksQueryId(BUNDLE_QUERYID_FIRST)).toBe("AbCd1234_-xy");
  });
  it("extracts when operationName precedes queryId", () => {
    expect(extractBookmarksQueryId(BUNDLE_OPNAME_FIRST)).toBe("Zz99__opfirst");
  });
  it("returns null when Bookmarks operation absent", () => {
    expect(extractBookmarksQueryId(BUNDLE_NO_MATCH)).toBeNull();
  });
  it("returns null on empty / malformed input", () => {
    expect(extractBookmarksQueryId("")).toBeNull();
    expect(extractBookmarksQueryId("garbage {{{")).toBeNull();
  });
});

describe("findBundleUrls", () => {
  it("pulls client-web js urls and dedupes", () => {
    const html = `<script src="https://abs.twimg.com/responsive-web/client-web/main.abc.js"></script>
      <script src="https://abs.twimg.com/responsive-web/client-web/api.def.js"></script>
      <script src="https://abs.twimg.com/responsive-web/client-web/main.abc.js"></script>`;
    expect(findBundleUrls(html).sort()).toEqual([
      "https://abs.twimg.com/responsive-web/client-web/api.def.js",
      "https://abs.twimg.com/responsive-web/client-web/main.abc.js",
    ]);
  });
  it("returns [] when none present", () => {
    expect(findBundleUrls("<html></html>")).toEqual([]);
  });
});

describe("resolveQueryId precedence", () => {
  it("override wins without any fetch", async () => {
    const fetchText = vi.fn();
    const r = await resolveQueryId({ override: " myOverride ", fetchText, now: () => 0 });
    expect(r).toEqual({ queryId: "myOverride", source: "override" });
    expect(fetchText).not.toHaveBeenCalled();
  });

  it("fresh cache is used without fetching", async () => {
    const fetchText = vi.fn();
    const r = await resolveQueryId({
      fetchText,
      now: () => 1000,
      cache: { value: "cached", fetchedAt: 900 },
      ttlMs: 500,
    });
    expect(r).toEqual({ queryId: "cached", source: "cache" });
    expect(fetchText).not.toHaveBeenCalled();
  });

  it("stale cache triggers re-discovery and caches the new value", async () => {
    const setCache = vi.fn();
    const fetchText = vi.fn(async (url: string) =>
      url === "https://x.com/" ? BUNDLE_QUERYID_FIRST : ""
    );
    const r = await resolveQueryId({
      fetchText,
      now: () => 10_000,
      cache: { value: "old", fetchedAt: 0 },
      ttlMs: 500,
      entryUrls: ["https://x.com/"],
      setCache,
    });
    expect(r).toEqual({ queryId: "AbCd1234_-xy", source: "discovered" });
    expect(setCache).toHaveBeenCalledWith({ value: "AbCd1234_-xy", fetchedAt: 10_000 });
  });

  it("falls back to STATIC_FALLBACK when discovery fails and no cache", async () => {
    const warn = vi.fn();
    const r = await resolveQueryId({
      fetchText: async () => "<html>no bundles</html>",
      now: () => 0,
      entryUrls: ["https://x.com/"],
      warn,
    });
    expect(r).toEqual({ queryId: STATIC_FALLBACK_QUERY_ID, source: "fallback" });
    expect(warn).toHaveBeenCalled();
  });

  it("prefers stale cache over static fallback when discovery fails", async () => {
    const r = await resolveQueryId({
      fetchText: async () => "<html>no bundles</html>",
      now: () => 10_000,
      cache: { value: "stale", fetchedAt: 0 },
      ttlMs: 500,
      entryUrls: ["https://x.com/"],
    });
    expect(r).toEqual({ queryId: "stale", source: "stale-cache" });
  });
});

describe("discovery follows bundle references and is bounded", () => {
  it("follows a bundle url found in entry html", async () => {
    const fetchText = vi.fn(async (url: string) => {
      if (url === "https://x.com/")
        return `<script src="https://abs.twimg.com/responsive-web/client-web/api.x.js"></script>`;
      if (url === "https://abs.twimg.com/responsive-web/client-web/api.x.js")
        return BUNDLE_OPNAME_FIRST;
      return "";
    });
    const id = await discoverQueryId({ fetchText, now: () => 0, entryUrls: ["https://x.com/"] });
    expect(id).toBe("Zz99__opfirst");
  });

  it("stops scanning after MAX_BUNDLES_SCANNED", async () => {
    // Entry references one bundle; every bundle references a fresh next bundle, never matching.
    let counter = 0;
    const fetchText = vi.fn(async (url: string) => {
      if (url === "https://x.com/")
        return `https://abs.twimg.com/responsive-web/client-web/b0.js`;
      counter++;
      return `https://abs.twimg.com/responsive-web/client-web/b${counter}.js`;
    });
    const warn = vi.fn();
    const id = await discoverQueryId({
      fetchText,
      now: () => 0,
      entryUrls: ["https://x.com/"],
      warn,
    });
    expect(id).toBeNull();
    // 1 entry fetch + at most MAX_BUNDLES_SCANNED bundle fetches
    expect(fetchText.mock.calls.length).toBeLessThanOrEqual(MAX_BUNDLES_SCANNED + 1);
    expect(warn).toHaveBeenCalled();
  });
});

describe("forceRefreshQueryId", () => {
  it("throws a clear error when nothing is discoverable", async () => {
    await expect(
      forceRefreshQueryId({
        fetchText: async () => "<html></html>",
        now: () => 0,
        entryUrls: ["https://x.com/"],
      })
    ).rejects.toThrow(/queryId/i);
  });
});
