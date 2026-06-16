import type { FetchPageFn, RawResponse } from "./client";
import { extractTimelineEntries } from "../model/timeline";

/**
 * Paginated Bookmarks fetch loop with Ken's hard-rule guardrails (R7): a
 * MAX_PAGES ceiling, no-progress detection (cursor unchanged or zero new
 * entries), bounded 429 exponential backoff, and progress emitted after every
 * page so a sync can be interrupted and resumed.
 *
 * Status classification raises typed errors so callers can react precisely:
 *   401 -> AuthError (re-login)   404/GraphQL errors -> QueryIdRotationError
 *   400 + missing feature -> FeaturesError   429 (exhausted) -> RateLimitError
 *
 * The page fetcher is injected (see makeFetchPage), so the whole loop is tested
 * against scripted fixtures with no network.
 */

export class AuthError extends Error {}
export class RateLimitError extends Error {}
export class QueryIdRotationError extends Error {}
export class FeaturesError extends Error {}
export class BookmarksFetchError extends Error {}

export type StopReason = "max-pages" | "no-progress" | "end-of-list" | "caught-up";

export interface BookmarksProgress {
  page: number;
  cursor: string | null;
  collected: number; // tweet results gathered this run
  seen: number; // distinct ids seen (incl. resumed)
}

export interface FetchBookmarksOptions {
  fetchPage: FetchPageFn;
  maxPages: number;
  startCursor?: string | null;
  /** Ids already collected in a prior run (enables resume + no-progress stop). */
  seenIds?: Set<string>;
  /** Incremental mode: stop at the first page that contains an already-seen
   *  bookmark (after collecting the new ones on it). Used once the initial
   *  backfill is complete so we don't re-walk the whole history each sync. */
  stopOnSeen?: boolean;
  onProgress?: (p: BookmarksProgress) => void | Promise<void>;
  maxBackoffRetries?: number;
  backoffBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchBookmarksResult {
  /** `tweet_results.result` objects across all fetched pages, in order. */
  results: any[];
  lastCursor: string | null;
  stopReason: StopReason;
  pagesFetched: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fetchAllBookmarks(opts: FetchBookmarksOptions): Promise<FetchBookmarksResult> {
  const {
    fetchPage,
    maxPages,
    onProgress,
    maxBackoffRetries = 4,
    backoffBaseMs = 1000,
    sleep = defaultSleep,
  } = opts;

  const seen = opts.seenIds ?? new Set<string>();
  const results: any[] = [];
  let cursor = opts.startCursor ?? null;
  let page = 0;

  const collect = (entries: { id: string; result: any }[]) => {
    for (const e of entries) {
      seen.add(e.id);
      results.push(e.result);
    }
  };

  while (true) {
    // Guardrail: hard page ceiling (checked before fetching).
    if (page >= maxPages) {
      return finish("max-pages");
    }

    const raw = await fetchPageWithBackoff(cursor);
    classifyStatus(raw);
    page += 1; // a page was actually fetched

    const { tweetEntries, bottomCursor } = extractTimelineEntries(raw.json);
    const newEntries = tweetEntries.filter((e) => !seen.has(e.id));

    // Guardrail: natural end of the list.
    if (tweetEntries.length === 0 || !bottomCursor) {
      collect(newEntries);
      return finish("end-of-list");
    }

    // Guardrail: no progress -> stop instead of spinning.
    // (cursor didn't advance, OR every entry on this page was already seen).
    if (bottomCursor === cursor || newEntries.length === 0) {
      collect(newEntries);
      return finish("no-progress");
    }

    // Incremental stop: this page straddles the boundary between new and
    // already-synced bookmarks (timeline is newest-first), so everything below
    // is already saved — collect the new ones here and stop.
    if (opts.stopOnSeen && newEntries.length < tweetEntries.length) {
      collect(newEntries);
      return finish("caught-up");
    }

    collect(newEntries);
    cursor = bottomCursor;
    await onProgress?.({ page, cursor, collected: results.length, seen: seen.size });
  }

  function finish(stopReason: StopReason): FetchBookmarksResult {
    return { results, lastCursor: cursor, stopReason, pagesFetched: page };
  }

  async function fetchPageWithBackoff(c: string | null): Promise<RawResponse> {
    let attempt = 0;
    while (true) {
      const raw = await fetchPage(c);
      if (raw.status !== 429) return raw;
      // Guardrail: bounded exponential backoff on rate limiting.
      if (attempt >= maxBackoffRetries) {
        throw new RateLimitError(
          `Rate limited by X (429) after ${maxBackoffRetries} retries. Try again later.`
        );
      }
      await sleep(backoffBaseMs * 2 ** attempt);
      attempt += 1;
    }
  }
}

function classifyStatus(raw: RawResponse): void {
  if (raw.status === 200) {
    if (hasGraphqlErrors(raw.json)) {
      throw new QueryIdRotationError(graphqlErrorMessage(raw.json));
    }
    return;
  }
  if (raw.status === 401 || raw.status === 403) {
    throw new AuthError("X session is invalid or expired (HTTP " + raw.status + "). Please log in again.");
  }
  if (raw.status === 404) {
    throw new QueryIdRotationError(
      "Bookmarks endpoint returned 404 — the queryId has likely rotated. Refresh it or set an override in settings."
    );
  }
  if (raw.status === 400) {
    const msg = errorBodyText(raw);
    if (/feature/i.test(msg)) {
      throw new FeaturesError(`X rejected the request features (HTTP 400): ${msg}`);
    }
    throw new BookmarksFetchError(`Bad request (HTTP 400): ${msg}`);
  }
  if (raw.status === 429) {
    // Should be handled by backoff; reaching here means exhausted upstream.
    throw new RateLimitError("Rate limited by X (429).");
  }
  throw new BookmarksFetchError(`Unexpected response from X (HTTP ${raw.status}). ${errorBodyText(raw)}`);
}

function hasGraphqlErrors(json: any): boolean {
  return Array.isArray(json?.errors) && json.errors.length > 0;
}

function graphqlErrorMessage(json: any): string {
  const first = json?.errors?.[0];
  const msg = first?.message ?? "GraphQL error";
  return `X GraphQL error: ${msg}. The queryId or request shape may have changed.`;
}

function errorBodyText(raw: RawResponse): string {
  if (raw.json?.errors?.[0]?.message) return String(raw.json.errors[0].message);
  return (raw.text || "").slice(0, 300);
}
