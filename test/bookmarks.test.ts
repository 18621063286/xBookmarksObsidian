import { describe, it, expect, vi } from "vitest";
import {
  fetchAllBookmarks,
  AuthError,
  RateLimitError,
  QueryIdRotationError,
  FeaturesError,
} from "../src/api/bookmarks";
import type { RawResponse } from "../src/api/client";

// --- fixture builders -------------------------------------------------------

function tweetEntry(id: string) {
  return {
    entryId: `tweet-${id}`,
    content: {
      entryType: "TimelineTimelineItem",
      itemContent: { tweet_results: { result: { rest_id: id, legacy: {} } } },
    },
  };
}

function cursorEntry(value: string) {
  return {
    entryId: `cursor-bottom-${value}`,
    content: { entryType: "TimelineTimelineCursor", cursorType: "Bottom", value },
  };
}

/** A 200 page with the given tweet ids and an optional bottom cursor. */
function page(ids: string[], bottomCursor: string | null): RawResponse {
  const entries: any[] = ids.map(tweetEntry);
  if (bottomCursor) entries.push(cursorEntry(bottomCursor));
  return {
    status: 200,
    text: "",
    json: {
      data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: "TimelineAddEntries", entries }] } } },
    },
  };
}

const ok = (status: number, json: any = {}, text = ""): RawResponse => ({ status, json, text });

// --- tests ------------------------------------------------------------------

describe("fetchAllBookmarks happy path", () => {
  it("collects all entries across two pages until end-of-list", async () => {
    const pages: Record<string, RawResponse> = {
      "null": page(["1", "2"], "c1"),
      c1: page(["3", "4"], null), // no bottom cursor => end
    };
    const fetchPage = vi.fn(async (cursor: string | null) => pages[String(cursor)]);

    const res = await fetchAllBookmarks({ fetchPage, maxPages: 50 });

    expect(res.results.map((r) => r.rest_id)).toEqual(["1", "2", "3", "4"]);
    expect(res.stopReason).toBe("end-of-list");
    expect(res.pagesFetched).toBe(2);
  });

  it("emits progress after each advancing page (resumable)", async () => {
    const pages: Record<string, RawResponse> = {
      "null": page(["1"], "c1"),
      c1: page(["2"], null),
    };
    const onProgress = vi.fn();
    await fetchAllBookmarks({
      fetchPage: async (c) => pages[String(c)],
      maxPages: 50,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, cursor: "c1", collected: 1 })
    );
  });
});

describe("guardrails", () => {
  it("stops at MAX_PAGES even when the list never ends", async () => {
    let n = 0;
    const fetchPage = vi.fn(async () => {
      n += 1;
      return page([`${n}a`, `${n}b`], `cursor-${n}`); // always a fresh cursor + new ids
    });
    const res = await fetchAllBookmarks({ fetchPage, maxPages: 3 });
    expect(res.stopReason).toBe("max-pages");
    expect(res.pagesFetched).toBe(3);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("stops on no-progress when the cursor does not advance", async () => {
    const fetchPage = vi.fn(async (cursor: string | null) => {
      if (cursor === null) return page(["1", "2"], "c1");
      return page(["3", "4"], "c1"); // returns the SAME cursor it was given
    });
    const res = await fetchAllBookmarks({ fetchPage, maxPages: 50 });
    expect(res.stopReason).toBe("no-progress");
    // page 2's fresh entries are still collected before stopping
    expect(res.results.map((r) => r.rest_id)).toEqual(["1", "2", "3", "4"]);
  });

  it("stops on no-progress when a page has zero new entries (caught up)", async () => {
    const fetchPage = vi.fn(async (cursor: string | null) => {
      if (cursor === null) return page(["1", "2"], "c1");
      return page(["1", "2"], "c2"); // all already seen
    });
    const res = await fetchAllBookmarks({ fetchPage, maxPages: 50 });
    expect(res.stopReason).toBe("no-progress");
    expect(res.results.map((r) => r.rest_id)).toEqual(["1", "2"]);
  });
});

describe("incremental stopOnSeen", () => {
  it("stops at the first page containing an already-synced bookmark", async () => {
    const pages: Record<string, RawResponse> = {
      "null": page(["1", "2", "3", "4"], "c1"), // 1,2 already synced; 3,4 new
      c1: page(["5", "6"], null),
    };
    const res = await fetchAllBookmarks({
      fetchPage: async (c) => pages[String(c)],
      maxPages: 50,
      seenIds: new Set(["1", "2"]),
      stopOnSeen: true,
    });
    expect(res.stopReason).toBe("caught-up");
    expect(res.results.map((r) => r.rest_id)).toEqual(["3", "4"]);
    expect(res.pagesFetched).toBe(1); // did not fetch page 2
  });

  it("without stopOnSeen it keeps paginating through the backlog", async () => {
    const pages: Record<string, RawResponse> = {
      "null": page(["1", "2", "3", "4"], "c1"),
      c1: page(["5", "6"], null),
    };
    const res = await fetchAllBookmarks({
      fetchPage: async (c) => pages[String(c)],
      maxPages: 50,
      seenIds: new Set(["1", "2"]),
    });
    expect(res.stopReason).toBe("end-of-list");
    expect(res.results.map((r) => r.rest_id)).toEqual(["3", "4", "5", "6"]);
  });

  it("first backfill (nothing seen) is not stopped early by stopOnSeen", async () => {
    const pages: Record<string, RawResponse> = {
      "null": page(["1", "2"], "c1"),
      c1: page(["3", "4"], null),
    };
    const res = await fetchAllBookmarks({
      fetchPage: async (c) => pages[String(c)],
      maxPages: 50,
      seenIds: new Set(),
      stopOnSeen: true,
    });
    expect(res.results.map((r) => r.rest_id)).toEqual(["1", "2", "3", "4"]);
    expect(res.stopReason).toBe("end-of-list");
  });
});

describe("resume", () => {
  it("skips already-seen ids supplied via seenIds", async () => {
    const pages: Record<string, RawResponse> = {
      "null": page(["1", "2", "3"], "c1"),
      c1: page(["4"], null),
    };
    const res = await fetchAllBookmarks({
      fetchPage: async (c) => pages[String(c)],
      maxPages: 50,
      seenIds: new Set(["1", "2"]),
    });
    expect(res.results.map((r) => r.rest_id)).toEqual(["3", "4"]);
  });
});

describe("rate limiting (429)", () => {
  it("backs off and retries, then succeeds", async () => {
    const seq: RawResponse[] = [ok(429), ok(429), page(["1"], null)];
    let i = 0;
    const sleep = vi.fn(async () => {});
    const res = await fetchAllBookmarks({
      fetchPage: async () => seq[i++],
      maxPages: 50,
      sleep,
    });
    expect(res.results.map((r) => r.rest_id)).toEqual(["1"]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("throws RateLimitError after exhausting retries", async () => {
    const sleep = vi.fn(async () => {});
    await expect(
      fetchAllBookmarks({
        fetchPage: async () => ok(429),
        maxPages: 50,
        maxBackoffRetries: 2,
        sleep,
      })
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("error classification", () => {
  it("401 -> AuthError (re-login)", async () => {
    await expect(
      fetchAllBookmarks({ fetchPage: async () => ok(401), maxPages: 5 })
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("404 -> QueryIdRotationError", async () => {
    await expect(
      fetchAllBookmarks({ fetchPage: async () => ok(404), maxPages: 5 })
    ).rejects.toBeInstanceOf(QueryIdRotationError);
  });

  it("200 with GraphQL errors -> QueryIdRotationError", async () => {
    await expect(
      fetchAllBookmarks({
        fetchPage: async () => ok(200, { errors: [{ message: "Bad query" }] }),
        maxPages: 5,
      })
    ).rejects.toBeInstanceOf(QueryIdRotationError);
  });

  it("400 naming a feature -> FeaturesError", async () => {
    await expect(
      fetchAllBookmarks({
        fetchPage: async () => ok(400, undefined, "The following features cannot be null: foo"),
        maxPages: 5,
      })
    ).rejects.toBeInstanceOf(FeaturesError);
  });
});
