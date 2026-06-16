/**
 * queryId resolution for the X internal GraphQL `Bookmarks` operation.
 *
 * X rotates GraphQL queryIds every ~2-8 weeks — the single most common cause of
 * sync breakage. Strategy (KTD2 / R3), in precedence order:
 *
 *   override (user setting)  >  fresh TTL cache  >  auto-discovery from JS bundle
 *     >  stale cache (better than a guess)  >  static fallback constant
 *
 * Auto-discovery and forced refresh NEVER fail silently — `forceRefresh` throws a
 * clear, diagnosable error when nothing usable is found.
 *
 * The pure pieces (`extractBookmarksQueryId`, `findBundleUrls`) carry no Obsidian
 * imports so they can be unit-tested against recorded bundle text.
 */

export interface QueryIdCacheEntry {
  value: string;
  fetchedAt: number; // epoch ms
}

export type QueryIdSource = "override" | "cache" | "discovered" | "stale-cache" | "fallback";

export interface ResolvedQueryId {
  queryId: string;
  source: QueryIdSource;
}

/**
 * Last-resort static value. X rotates this constant out of validity on its own
 * schedule — that's expected; discovery + override exist precisely to recover.
 */
export const STATIC_FALLBACK_QUERY_ID = "xLjCVTqYWz8Cn5robKvqVQ";

export const DEFAULT_QUERYID_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Bounded number of JS bundles to scan during discovery (loop guardrail). */
export const MAX_BUNDLES_SCANNED = 30;

const QUERYID_CHARS = "[a-zA-Z0-9_-]+";

/**
 * Extract the Bookmarks queryId from raw JS bundle text. Handles both key
 * orderings (queryId before/after operationName) seen in X's minified bundles.
 * Returns null when the operation isn't present or the shape changed.
 */
export function extractBookmarksQueryId(bundleText: string): string | null {
  if (!bundleText) return null;

  // queryId:"..."  ... operationName:"Bookmarks"
  const before = new RegExp(`queryId:\\s*"(${QUERYID_CHARS})"\\s*,\\s*operationName:\\s*"Bookmarks"`);
  const m1 = bundleText.match(before);
  if (m1) return m1[1];

  // operationName:"Bookmarks" ... queryId:"..."  (stay within the same object literal)
  const after = new RegExp(`operationName:\\s*"Bookmarks"[^}]*?queryId:\\s*"(${QUERYID_CHARS})"`);
  const m2 = bundleText.match(after);
  if (m2) return m2[1];

  return null;
}

/**
 * Pull candidate X client-web JS bundle URLs out of HTML or JS text.
 * Matches the abs.twimg.com client-web chunk URLs X references.
 */
export function findBundleUrls(text: string): string[] {
  if (!text) return [];
  const re = /https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"'\s)]+?\.js/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.add(m[0]);
  }
  return [...found];
}

export interface ResolveDeps {
  fetchText: (url: string) => Promise<string>;
  now: () => number;
  override?: string;
  cache?: QueryIdCacheEntry | null;
  setCache?: (entry: QueryIdCacheEntry) => void | Promise<void>;
  ttlMs?: number;
  /** Entry pages whose HTML references the client-web bundles. */
  entryUrls?: string[];
  /** Optional sink for non-fatal diagnostics. */
  warn?: (msg: string) => void;
}

const DEFAULT_ENTRY_URLS = ["https://x.com/", "https://x.com/i/bookmarks"];

/**
 * Best-effort discovery: scan entry HTML for bundle URLs, then scan bundles for
 * the Bookmarks queryId. Bounded by MAX_BUNDLES_SCANNED. Returns null if not found.
 */
export async function discoverQueryId(deps: ResolveDeps): Promise<string | null> {
  const entryUrls = deps.entryUrls ?? DEFAULT_ENTRY_URLS;
  const seen = new Set<string>();
  const queue: string[] = [];

  // Seed with bundle URLs referenced by the entry pages.
  for (const entry of entryUrls) {
    try {
      const html = await deps.fetchText(entry);
      // An entry page might itself be a bundle; scan it directly too.
      const direct = extractBookmarksQueryId(html);
      if (direct) return direct;
      for (const u of findBundleUrls(html)) if (!seen.has(u)) queue.push(u);
    } catch (e) {
      deps.warn?.(`queryId discovery: failed to fetch ${entry}: ${String(e)}`);
    }
  }

  let scanned = 0;
  while (queue.length > 0 && scanned < MAX_BUNDLES_SCANNED) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    scanned++;
    try {
      const js = await deps.fetchText(url);
      const id = extractBookmarksQueryId(js);
      if (id) return id;
      // Follow chunk references discovered inside this bundle (still bounded).
      for (const u of findBundleUrls(js)) if (!seen.has(u)) queue.push(u);
    } catch (e) {
      deps.warn?.(`queryId discovery: failed to fetch bundle ${url}: ${String(e)}`);
    }
  }

  if (scanned >= MAX_BUNDLES_SCANNED) {
    deps.warn?.(`queryId discovery: hit MAX_BUNDLES_SCANNED (${MAX_BUNDLES_SCANNED}) without a match`);
  }
  return null;
}

/**
 * Resolve a queryId for use. Always returns a value (never throws) so a sync can
 * proceed; `source` tells the caller how trustworthy it is. A `fallback`/`stale-cache`
 * result that then 404s downstream is the signal to force a refresh.
 */
export async function resolveQueryId(deps: ResolveDeps): Promise<ResolvedQueryId> {
  const override = deps.override?.trim();
  if (override) return { queryId: override, source: "override" };

  const ttl = deps.ttlMs ?? DEFAULT_QUERYID_TTL_MS;
  const cache = deps.cache ?? null;
  if (cache && cache.value && deps.now() - cache.fetchedAt < ttl) {
    return { queryId: cache.value, source: "cache" };
  }

  const discovered = await discoverQueryId(deps);
  if (discovered) {
    await deps.setCache?.({ value: discovered, fetchedAt: deps.now() });
    return { queryId: discovered, source: "discovered" };
  }

  if (cache && cache.value) {
    deps.warn?.("queryId discovery failed; using stale cached value.");
    return { queryId: cache.value, source: "stale-cache" };
  }

  deps.warn?.("queryId discovery failed and no cache; using static fallback (may be rotated).");
  return { queryId: STATIC_FALLBACK_QUERY_ID, source: "fallback" };
}

/**
 * Force a fresh discovery (used after a suspected rotation). Throws a clear,
 * diagnosable error when discovery yields nothing — never silent.
 */
export async function forceRefreshQueryId(deps: ResolveDeps): Promise<ResolvedQueryId> {
  const discovered = await discoverQueryId(deps);
  if (!discovered) {
    throw new Error(
      "Could not auto-discover the Bookmarks queryId — X may have changed its bundle format. " +
        "Set a manual queryId override in settings."
    );
  }
  await deps.setCache?.({ value: discovered, fetchedAt: deps.now() });
  return { queryId: discovered, source: "discovered" };
}
