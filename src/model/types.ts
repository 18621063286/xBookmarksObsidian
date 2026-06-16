/** Stable, render-ready bookmark model (the contract downstream code depends on). */

export type MediaType = "photo" | "video" | "gif";

export interface BookmarkMedia {
  type: MediaType;
  /** Remote CDN URL. May be rewritten to a local path when media is downloaded. */
  url: string;
  /** Original remote URL, preserved even after localization (for fallback/debug). */
  remoteUrl: string;
}

export interface BookmarkAuthor {
  name: string;
  handle: string;
  avatar: string;
}

export interface BookmarkCard {
  title: string;
  desc: string;
  thumb: string;
  url: string;
}

export interface Bookmark {
  tweetId: string;
  text: string;
  author: BookmarkAuthor;
  /** Original X timestamp string (e.g. "Wed Oct 10 20:19:24 +0000 2018"). */
  createdAt: string;
  permalink: string;
  media: BookmarkMedia[];
  /** One level of quoted tweet; deeper nesting is intentionally not followed. */
  quoted: Bookmark | null;
  card: BookmarkCard | null;
}
