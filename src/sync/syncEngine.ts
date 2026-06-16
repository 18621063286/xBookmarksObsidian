import { App, TFile, TFolder, normalizePath, requestUrl } from "obsidian";
import type { XBookmarksSettings } from "../settings";
import { validateCredentials, type Credentials } from "../auth/cookies";
import { resolveQueryId, forceRefreshQueryId, type ResolveDeps } from "../api/queryId";
import { makeFetchPage, USER_AGENT } from "../api/client";
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

  /** Returns the bookmarks newly written this run (for the AI digest). */
  async run(opts: SyncRunOptions = {}): Promise<Bookmark[]> {
    const { settings, notify } = this.deps;
    const creds: Credentials = { authToken: settings.authToken, ct0: settings.ct0 };

    const valid = validateCredentials(creds);
    if (!valid.valid) {
      notify(`${valid.reason} Log in to X or paste your cookie in settings.`);
      return [];
    }

    notify("Syncing X bookmarks…");
    const existing = this.scanExistingIds();
    const queryDeps = this.queryDeps();

    try {
      const resolved = await resolveQueryId(queryDeps);
      const result = await this.fetchWith(resolved.queryId, creds, existing);
      return await this.writeAll(result, existing, opts);
    } catch (e) {
      return await this.handleError(e, creds, existing, opts);
    }
  }

  /** Fetch + parse the full bookmark set without writing notes (for digest rebuild). */
  async fetchAllParsed(onPage?: (collected: number) => void): Promise<Bookmark[]> {
    const { settings, notify } = this.deps;
    const creds: Credentials = { authToken: settings.authToken, ct0: settings.ct0 };
    if (!validateCredentials(creds).valid) {
      notify("Not logged in to X.");
      return [];
    }
    const queryDeps = this.queryDeps();
    const resolved = await resolveQueryId(queryDeps);
    const fetchPage = makeFetchPage({ creds, queryId: resolved.queryId, bearer: settings.bearerOverride || undefined });
    const result = await fetchAllBookmarks({
      fetchPage,
      maxPages: settings.maxPages,
      startCursor: null,
      seenIds: new Set(), // want everything
      onProgress: (p) => onPage?.(p.collected),
    });
    return parseBookmarks(result.results);
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
      // Always start from the top. Written notes are the source of truth, not the
      // fetch cursor: we fetch all pages before writing, so a saved cursor would
      // point at the END of the timeline and resuming from it would skip every
      // not-yet-written bookmark in the middle. seenIds (existing notes) makes a
      // normal incremental run stop early once it reaches already-synced tweets.
      startCursor: null,
      seenIds: new Set(existing),
      // Once the full history is backfilled, stop at the first already-synced
      // bookmark so routine syncs only fetch what's new.
      stopOnSeen: settings.backfillComplete,
      onProgress: async (p) => {
        settings.lastSyncCursor = p.cursor ?? "";
        // Cursor persistence is best-effort — a disk hiccup must not abort the
        // in-flight fetch loop (the in-memory cursor is already updated).
        try {
          await this.deps.saveSettings();
        } catch (e) {
          console.warn("[x-bookmarks] failed to persist sync progress:", e);
        }
      },
    });
  }

  private async writeAll(
    result: FetchBookmarksResult,
    existing: Set<string>,
    opts: SyncRunOptions
  ): Promise<Bookmark[]> {
    const { app, settings, notify } = this.deps;
    const bookmarks = parseBookmarks(result.results);
    const plan = planSync(existing, bookmarks, opts.force);

    await this.ensureFolder(settings.noteFolder);
    const bookmarkedAt = new Date().toISOString();
    let created = 0;
    let modified = 0;
    let failed = 0;
    // Guards against double-create when a file made earlier in THIS run isn't
    // yet visible via getAbstractFileByPath (metadataCache/vault lag).
    const writtenThisRun = new Set<string>();
    // Notes written this run, for the optional best-effort media pass.
    const written: { path: string; bookmark: Bookmark }[] = [];

    // --- Phase 1: write note TEXT first (X CDN media links). ---
    // Text is the priority; it lands fast and reliably even if media is slow or
    // fails. Each note is isolated so one bad write can't abort the batch.
    for (const b of plan.toCreate) {
      try {
        const { filename, content } = renderNote(b, { bookmarkedAt, template: settings.template });
        const path = normalizePath(`${settings.noteFolder}/${filename}`);
        const file = app.vault.getAbstractFileByPath(path);
        const action = decideWrite(!!file || writtenThisRun.has(path), !!opts.force);

        if (action === "create" && !file) {
          try {
            await app.vault.create(path, content);
            created++;
            writtenThisRun.add(path);
            written.push({ path, bookmark: b });
          } catch (e) {
            if (!/already exists/i.test(String(e instanceof Error ? e.message : e))) throw e;
          }
        } else if (action === "modify" && file instanceof TFile) {
          await app.vault.modify(file, content);
          modified++;
          written.push({ path, bookmark: b });
        }
      } catch (e) {
        failed++;
        console.warn(`[x-bookmarks] failed to write bookmark ${b.tweetId}:`, e);
      }
    }

    // The full history has been walked end-to-end at least once -> future syncs
    // can stop early at the first already-synced bookmark.
    if (result.stopReason === "end-of-list" || result.stopReason === "caught-up") {
      settings.backfillComplete = true;
    }
    settings.lastSyncAt = bookmarkedAt;
    settings.lastSyncCursor = ""; // we always start from the top; cursor is diagnostic only
    await this.deps.saveSettings();

    const parts = [`${created} new`];
    if (opts.force) parts.push(`${modified} re-rendered`);
    parts.push(`${plan.skipped.length} skipped`);
    if (failed) parts.push(`${failed} failed`);
    notify(`X bookmarks synced — ${parts.join(", ")}.`);

    if (result.stopReason === "max-pages") {
      notify(
        `Reached the max-pages limit (${settings.maxPages}). If you have more than ${settings.maxPages * 100} bookmarks, raise "Max pages per sync" in settings and sync again.`
      );
    }

    // --- Phase 2: best-effort attachment download (text is already saved). ---
    // Runs after the success notice; failures are logged and skipped.
    if (settings.downloadMedia && written.length) {
      await this.localizeWritten(written, bookmarkedAt);
    }

    return written.map((w) => w.bookmark);
  }

  /** Download attachments for already-written notes and rewrite their links to
   *  local paths. Best-effort: failures keep the X CDN link and never block. */
  private async localizeWritten(
    written: { path: string; bookmark: Bookmark }[],
    bookmarkedAt: string
  ): Promise<void> {
    const { app, settings, notify } = this.deps;
    const attachments = `${settings.noteFolder}/_attachments`;
    let localized = 0;
    let mediaFailed = 0;

    for (const { path, bookmark } of written) {
      const before = mediaUrls(bookmark);
      try {
        await localizeBookmarkMedia(bookmark, attachments, this.mediaIO());
      } catch (e) {
        mediaFailed++;
        console.warn(`[x-bookmarks] media download failed for ${bookmark.tweetId}:`, e);
        continue;
      }
      if (mediaUrls(bookmark) === before) continue; // nothing localized
      try {
        const file = app.vault.getAbstractFileByPath(normalizePath(path));
        if (file instanceof TFile) {
          const { content } = renderNote(bookmark, { bookmarkedAt, template: settings.template });
          await app.vault.modify(file, content);
          localized++;
        }
      } catch (e) {
        mediaFailed++;
        console.warn(`[x-bookmarks] failed to update note with local media ${bookmark.tweetId}:`, e);
      }
    }

    if (localized || mediaFailed) {
      notify(`Attachments: ${localized} downloaded${mediaFailed ? `, ${mediaFailed} failed` : ""}.`);
    }
  }

  private async handleError(
    e: unknown,
    creds: Credentials,
    existing: Set<string>,
    opts: SyncRunOptions
  ): Promise<Bookmark[]> {
    const { notify } = this.deps;
    // Always log the real error (with type + message) so the dev console shows
    // the precise failure, not just the user-facing Notice summary.
    console.warn(`[x-bookmarks] sync error [${(e as any)?.constructor?.name}]:`, e);

    if (e instanceof QueryIdRotationError) {
      // Auto-recovery: force a queryId refresh and retry once.
      try {
        notify("Bookmarks queryId may have rotated — refreshing and retrying…");
        // Cursors are not portable across queryId changes — start the retry fresh.
        this.deps.settings.lastSyncCursor = "";
        const refreshed = await forceRefreshQueryId(this.queryDeps());
        const result = await this.fetchWith(refreshed.queryId, creds, existing);
        return await this.writeAll(result, existing, opts);
      } catch (e2) {
        notify(`Sync failed after queryId refresh: ${msg(e2)} Set a manual queryId override in settings.`);
      }
      return [];
    }
    if (e instanceof AuthError) {
      notify(`${msg(e)}`);
    } else if (e instanceof RateLimitError) {
      notify(`${msg(e)} Your progress is saved — run sync again later.`);
    } else if (e instanceof FeaturesError) {
      notify(`${msg(e)} The request features may need updating.`);
    } else {
      notify(`Sync failed: ${msg(e)}`);
    }
    return [];
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
      headers: { "user-agent": USER_AGENT },
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
    } catch (e) {
      // A concurrent create is benign; anything else (permissions, illegal path)
      // should surface rather than masquerade as a later vault.create failure.
      const m = e instanceof Error ? e.message.toLowerCase() : "";
      if (!m.includes("already exists") && !m.includes("exist")) throw e;
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

/** Snapshot a bookmark's (and its quoted tweet's) media urls, to detect whether
 *  a localization pass actually changed anything before re-writing the note. */
function mediaUrls(b: Bookmark): string {
  const urls = b.media.map((m) => m.url);
  if (b.quoted) urls.push(...b.quoted.media.map((m) => m.url));
  return urls.join("|");
}
