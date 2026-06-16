import { describe, it, expect } from "vitest";
import { planSync, decideWrite } from "../src/sync/syncEngine";
import type { Bookmark } from "../src/model/types";

function bm(id: string): Bookmark {
  return {
    tweetId: id,
    text: `tweet ${id}`,
    author: { name: "Alice", handle: "alice", avatar: "" },
    createdAt: "",
    permalink: `https://x.com/alice/status/${id}`,
    media: [],
    quoted: null,
    card: null,
  };
}

describe("planSync dedup decision", () => {
  it("first sync: everything is new", () => {
    const plan = planSync(new Set(), [bm("1"), bm("2"), bm("3")]);
    expect(plan.toCreate.map((b) => b.tweetId)).toEqual(["1", "2", "3"]);
    expect(plan.skipped).toEqual([]);
  });

  it("is idempotent: re-syncing with all existing creates nothing", () => {
    const existing = new Set(["1", "2", "3"]);
    const plan = planSync(existing, [bm("1"), bm("2"), bm("3")]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.skipped).toEqual(["1", "2", "3"]);
  });

  it("adds only the new bookmark", () => {
    const existing = new Set(["1", "2"]);
    const plan = planSync(existing, [bm("1"), bm("2"), bm("3")]);
    expect(plan.toCreate.map((b) => b.tweetId)).toEqual(["3"]);
    expect(plan.skipped).toEqual(["1", "2"]);
  });

  it("force re-renders everything regardless of existing", () => {
    const existing = new Set(["1", "2"]);
    const plan = planSync(existing, [bm("1"), bm("2"), bm("3")], true);
    expect(plan.toCreate.map((b) => b.tweetId)).toEqual(["1", "2", "3"]);
    expect(plan.skipped).toEqual([]);
  });

  it("de-duplicates within a single batch", () => {
    const plan = planSync(new Set(), [bm("1"), bm("1"), bm("2")]);
    expect(plan.toCreate.map((b) => b.tweetId)).toEqual(["1", "2"]);
  });
});

describe("decideWrite (never overwrite unless force)", () => {
  it("creates when the note does not exist", () => {
    expect(decideWrite(false, false)).toBe("create");
    expect(decideWrite(false, true)).toBe("create");
  });

  it("skips an existing note (protects manual edits)", () => {
    expect(decideWrite(true, false)).toBe("skip");
  });

  it("modifies an existing note only under force", () => {
    expect(decideWrite(true, true)).toBe("modify");
  });
});
