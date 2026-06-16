import { App, TFile, TFolder, normalizePath, requestUrl } from "obsidian";
import type { XBookmarksSettings } from "../settings";
import { validateCredentials, type Credentials } from "../auth/cookies";
import { resolveQueryId, forceRefreshQueryId, type ResolveDeps } from "../api/queryId";
import { makeFetchPage } from "../api/client";
import {
  fetchAllBookmarks,
  AuthError,
  QueryIdRotationError,
  RateLimitError,
  FeaturesError,
  type FetchBookmarksResult,
} from "../api/bookmarks";
import { parseBookmarks } from "../model/parser";
import { renderNote } from "../render/renderer";
import { localizeBookmarkMedia, type MediaIO } from "./media";
import type { Bookmark } from "../model/types";

/**
 * Incremental sync orchestrator (U7): login creds -> queryId -> paginated fetch
 * -> parse -> dedup by immutable tweet_id -> render -> write. Existing bookmarks
 * are skipped and NEVER overwritten (R6/KTD5) unless `force` re-render is asked.
 */

// --- pure, unit-tested decision logic ---------------------------------------

export interface SyncPlan {
  toCreate: Bookmark[];
  skipped: string[];
}

/**
 * Decide which bookmarks to write. Without `force`, anything whose tweet_id is
 * already in the vault is skipped. Also de-duplicates within the batch itself.
 */
export function planSync(existingIds: Set<string>, bookmarks: Bookmark[], force = false): SyncPlan {
  const toCreate: Bookmark[] = [];
  const skipped: string[] = [];
  const seenThisBatch = new Set<string>();

  for (const b of bookmarks) {
    if (seenThisBatch.has(b.tweetId)) continue;
    seenThisBatch.add(b.tweetId);
    if (!force && existingIds.has(b.tweetId)) skipped.push(b.tweetId);
    else toCreate.push(b);
  }
  return { toCreate, skipped };
}

export type WriteAction = "create" | "modify" | "skip";

/** Never overwrite an existing note unless force re-render is requested. */
export function decideWrite(exists: boolean, force: boolean): WriteAction {
  if (!exists) return "create";
  return force ? "modify" : "skip";
}

// --- orchestrator -----------------------------------------------------------

export interface SyncDeps {
  app: App;
  settings: XBookmarksSettings;
  saveSettings: () => Promise<void>;
  notify: (msg: string) => void;
}

export interface SyncRunOptions {
  force?: boolean;
}

export class SyncEngine {
  constructor(private deps: SyncDeps) {}

  async run(opts: SyncRunOptions = {}): Promise<void> {
    const { settings, notify } = this.deps;
    const creds: Credentials = { authToken: settings.authToken, ct0: settings.ct0 };

    const valid = validateCredentials(creds);
    if (!valid.valid) {
      notify(`${valid.reason} Log in to X or paste your cookie in settings.`);
      return;
    }

    notify("Syncing X bookmarks…");
    const existing = this.scanExistingIds();
    const queryDeps = this.queryDeps();

    try {
      const resolved = await resolveQueryId(queryDeps);
      const result = await this.fetchWith(resolved.queryId, creds, existing);
      await this.writeAll(result, existing, opts);
    } catch (e) {
      await this.handleError(e, creds, existing, opts);
    }
  }

  // --- pipeline steps ---

  private async fetchWith(
    queryId: string,
    creds: Credentials,
    existing: Set<string>
  ): Promise<FetchBookmarksResult> {
    const { settings } = this.deps;
    const fetchPage = makeFetchPage({
      creds,
      queryId,
      bearer: settings.bearerOverride || undefined,
    });

    return fetchAllBookmarks({
      fetchPage,
      maxPages: settings.maxPages,
      // Start from the top and stop early when we reach already-synced bookmarks.
      seenIds: new Set(existing),
      onProgress: async (p) => {
        settings.lastSyncCursor = p.cursor ?? "";
        await this.deps.saveSettings();
      },
    });
  }

  private async writeAll(
    result: FetchBookmarksResult,
    existing: Set<string>,
    opts: SyncRunOptions
  ): Promise<void> {
    const { app, settings, notify } = this.deps;
    const bookmarks = parseBookmarks(result.results);
    const plan = planSync(existing, bookmarks, opts.force);

    await this.ensureFolder(settings.noteFolder);
    const bookmarkedAt = new Date().toISOString();
    let created = 0;
    let modified = 0;

    for (const b of plan.toCreate) {
      if (settings.downloadMedia) {
        await localizeBookmarkMedia(b, `${settings.noteFolder}/_attachments`, this.mediaIO());
      }
      const { filename, content } = renderNote(b, { bookmarkedAt, template: settings.template });
      const path = normalizePath(`${settings.noteFolder}/${filename}`);
      const file = app.vault.getAbstractFileByPath(path);
      const action = decideWrite(!!file, !!opts.force);

      if (action === "create" && !file) {
        await app.vault.create(path, content);
        created++;
      } else if (action === "modify" && file instanceof TFile) {
        await app.vault.modify(file, content);
        modified++;
      }
    }

    settings.lastSyncAt = bookmarkedAt;
    settings.lastSyncCursor = ""; // completed cleanly; next run starts from top
    await this.deps.saveSettings();

    const parts = [`${created} new`];
    if (opts.force) parts.push(`${modified} re-rendered`);
    parts.push(`${plan.skipped.length} skipped`);
    notify(`X bookmarks synced — ${parts.join(", ")} (stopped: ${result.stopReason}).`);
  }

  private async handleError(
    e: unknown,
    creds: Credentials,
    existing: Set<string>,
    opts: SyncRunOptions
  ): Promise<void> {
    const { notify } = this.deps;

    if (e instanceof QueryIdRotationError) {
      // Auto-recovery: force a queryId refresh and retry once.
      try {
        notify("Bookmarks queryId may have rotated — refreshing and retrying…");
        const refreshed = await forceRefreshQueryId(this.queryDeps());
        const result = await this.fetchWith(refreshed.queryId, creds, existing);
        await this.writeAll(result, existing, opts);
      } catch (e2) {
        notify(`Sync failed after queryId refresh: ${msg(e2)} Set a manual queryId override in settings.`);
      }
      return;
    }
    if (e instanceof AuthError) {
      notify(`${msg(e)}`);
      return;
    }
    if (e instanceof RateLimitError) {
      notify(`${msg(e)} Your progress is saved — run sync again later.`);
      return;
    }
    if (e instanceof FeaturesError) {
      notify(`${msg(e)} The request features may need updating.`);
      return;
    }
    notify(`Sync failed: ${msg(e)}`);
  }

  // --- helpers ---

  private queryDeps(): ResolveDeps {
    const { settings } = this.deps;
    return {
      fetchText: (url) => this.requestText(url),
      now: () => Date.now(),
      override: settings.queryIdOverride,
      cache: settings.queryIdCache,
      setCache: async (entry) => {
        settings.queryIdCache = entry;
        await this.deps.saveSettings();
      },
      warn: (m) => console.warn("[x-bookmarks]", m),
    };
  }

  private async requestText(url: string): Promise<string> {
    const res = await requestUrl({
      url,
      method: "GET",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    } as any);
    return res.text ?? "";
  }

  /** Scan the vault for notes carrying the dedup sentinel and collect tweet ids. */
  private scanExistingIds(): Set<string> {
    const { app, settings } = this.deps;
    const ids = new Set<string>();
    const folderPrefix = normalizePath(settings.noteFolder) + "/";
    for (const file of app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(folderPrefix)) continue;
      const fm = app.metadataCache.getFileCache(file)?.frontmatter;
      if (fm && fm.doc_type === "x-bookmark" && fm.tweet_id != null) {
        ids.add(String(fm.tweet_id));
      }
    }
    return ids;
  }

  private async ensureFolder(folder: string): Promise<void> {
    const { app } = this.deps;
    const path = normalizePath(folder);
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) return;
    try {
      await app.vault.createFolder(path);
    } catch {
      // already exists (race) — ignore
    }
  }

  private mediaIO(): MediaIO {
    const { app } = this.deps;
    return {
      download: async (url) => {
        const res = await requestUrl({ url, method: "GET" } as any);
        return res.arrayBuffer;
      },
      writeBinary: async (path, data) => {
        await app.vault.createBinary(normalizePath(path), data);
      },
      exists: (path) => app.vault.getAbstractFileByPath(normalizePath(path)) != null,
      ensureFolder: (path) => this.ensureFolder(path),
      warn: (m) => console.warn("[x-bookmarks]", m),
    };
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
