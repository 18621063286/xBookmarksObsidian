import { requestUrl } from "obsidian";
import { buildCookieHeader, type Credentials } from "../auth/cookies";

/**
 * Low-level X GraphQL client (KTD3/KTD4): all requests go through Obsidian's
 * `requestUrl` (runs in the main process, bypasses CORS). The actual transport
 * is injectable so the pagination loop can be tested without the network.
 */

/**
 * Static web bearer token. Public, shared by all web clients, stable for 2+ years.
 * Overridable in settings just in case.
 */
export const STATIC_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * GraphQL `features` map required by the Bookmarks endpoint. X rejects requests
 * (HTTP 400, body names the missing feature) when this drifts — that error is
 * surfaced clearly by the loop. Overridable via settings if needed.
 */
export const DEFAULT_FEATURES: Record<string, boolean> = {
  rweb_video_screen_enabled: false,
  rweb_cashtags_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: false,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

export interface RawResponse {
  status: number;
  json: any;
  text: string;
}

export type RequestFn = (params: {
  url: string;
  method: string;
  headers: Record<string, string>;
}) => Promise<RawResponse>;

export function buildHeaders(creds: Credentials, bearer?: string): Record<string, string> {
  return {
    authorization: `Bearer ${bearer || STATIC_BEARER}`,
    "x-csrf-token": creds.ct0,
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
    "content-type": "application/json",
    cookie: buildCookieHeader(creds),
    "user-agent": USER_AGENT,
    accept: "*/*",
  };
}

export function buildBookmarksUrl(
  queryId: string,
  opts: { cursor?: string | null; count?: number; features?: Record<string, boolean> }
): string {
  const variables: Record<string, unknown> = {
    count: opts.count ?? 100,
    includePromotedContent: false,
  };
  if (opts.cursor) variables.cursor = opts.cursor;

  const features = opts.features ?? DEFAULT_FEATURES;
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(features),
  });
  return `https://x.com/i/api/graphql/${queryId}/Bookmarks?${params.toString()}`;
}

/**
 * Default transport over Obsidian's requestUrl. Normalizes non-2xx into a
 * RawResponse (rather than throwing) so the loop owns all status classification.
 */
export const obsidianRequest: RequestFn = async ({ url, method, headers }) => {
  try {
    const res = await requestUrl({ url, method, headers, throw: false } as any);
    return { status: res.status, json: safeJson(res), text: res.text ?? "" };
  } catch (e: any) {
    // Older requestUrl throws on non-2xx; recover the status AND any body so
    // 400-feature / GraphQL-error classification still works on those builds.
    if (typeof e?.status === "number") {
      let json: any = e?.json;
      if (json === undefined && typeof e?.body === "string") {
        try {
          json = JSON.parse(e.body);
        } catch {
          /* leave json undefined */
        }
      }
      return { status: e.status, json, text: String(e?.body ?? e?.message ?? "") };
    }
    throw e;
  }
};

function safeJson(res: any): any {
  try {
    return res.json;
  } catch {
    try {
      return JSON.parse(res.text);
    } catch {
      return undefined;
    }
  }
}

export interface ClientConfig {
  creds: Credentials;
  queryId: string;
  bearer?: string;
  features?: Record<string, boolean>;
  count?: number;
  request?: RequestFn;
}

export type FetchPageFn = (cursor: string | null) => Promise<RawResponse>;

/** Build a cursor->RawResponse fetcher bound to credentials + queryId. */
export function makeFetchPage(cfg: ClientConfig): FetchPageFn {
  const request = cfg.request ?? obsidianRequest;
  const headers = buildHeaders(cfg.creds, cfg.bearer);
  return (cursor: string | null) =>
    request({
      url: buildBookmarksUrl(cfg.queryId, { cursor, count: cfg.count, features: cfg.features }),
      method: "GET",
      headers,
    });
}
