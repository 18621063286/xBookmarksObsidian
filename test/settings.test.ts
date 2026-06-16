import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settings";

describe("settings defaults", () => {
  it("ships sensible defaults", () => {
    expect(DEFAULT_SETTINGS.noteFolder).toBe("Twitter");
    expect(DEFAULT_SETTINGS.scheduledSyncEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.downloadMedia).toBe(false);
    expect(DEFAULT_SETTINGS.maxPages).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.scheduledSyncInterval).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.authToken).toBe("");
    expect(DEFAULT_SETTINGS.ct0).toBe("");
  });
});

describe("mergeSettings (loadData round-trip)", () => {
  it("returns defaults when nothing persisted", () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("overlays persisted values over defaults", () => {
    const merged = mergeSettings({ noteFolder: "Bookmarks", maxPages: 10 });
    expect(merged.noteFolder).toBe("Bookmarks");
    expect(merged.maxPages).toBe(10);
    // untouched keys keep defaults
    expect(merged.scheduledSyncInterval).toBe(DEFAULT_SETTINGS.scheduledSyncInterval);
  });

  it("does not mutate DEFAULT_SETTINGS", () => {
    const merged = mergeSettings({ noteFolder: "X" });
    merged.noteFolder = "mutated";
    expect(DEFAULT_SETTINGS.noteFolder).toBe("Twitter");
  });

  it("preserves unknown persisted keys without throwing", () => {
    expect(() => mergeSettings({ legacyKey: 1 } as any)).not.toThrow();
  });
});
