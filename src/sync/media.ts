import type { Bookmark, BookmarkMedia } from "../model/types";

/**
 * Optional media localization (U8/R9): download each media file into the
 * attachments folder and rewrite the bookmark's media url to a local relative
 * path, so notes survive the original tweet being deleted. All I/O is injected
 * so this is unit-testable without Obsidian.
 *
 * Failure is non-fatal: on any download error the CDN url is kept and a warning
 * is emitted — media never blocks a note from being written.
 */

export interface MediaIO {
  /** Fetch remote bytes. */
  download: (url: string) => Promise<ArrayBuffer>;
  /** Write bytes to a vault-relative path. */
  writeBinary: (path: string, data: ArrayBuffer) => Promise<void>;
  /** Does a vault file already exist at this path? */
  exists: (path: string) => boolean;
  /** Ensure the containing folder exists. */
  ensureFolder: (path: string) => Promise<void>;
  warn?: (msg: string) => void;
}

const EXT_BY_TYPE: Record<BookmarkMedia["type"], string> = {
  photo: "jpg",
  video: "mp4",
  gif: "mp4",
};

function extFromUrl(url: string, fallback: string): string {
  const m = url.split("?")[0].match(/\.([a-zA-Z0-9]{2,4})$/);
  return m ? m[1] : fallback;
}

/** Localize a single tweet's media (not its quoted tweet). */
export async function localizeMedia(
  tweetId: string,
  media: BookmarkMedia[],
  attachmentsFolder: string,
  io: MediaIO
): Promise<void> {
  if (media.length === 0) return;
  await io.ensureFolder(attachmentsFolder);

  for (let i = 0; i < media.length; i++) {
    const item = media[i];
    const ext = extFromUrl(item.remoteUrl, EXT_BY_TYPE[item.type]);
    const filename = `${tweetId}-${i}.${ext}`;
    const path = `${attachmentsFolder}/${filename}`;
    try {
      if (!io.exists(path)) {
        const data = await io.download(item.remoteUrl);
        await io.writeBinary(path, data);
      }
      // Rewrite to a local relative path; keep remoteUrl for fallback/debug.
      item.url = path;
    } catch (e) {
      io.warn?.(`media download failed for ${item.remoteUrl}: ${String(e)} — keeping CDN url`);
      // leave item.url as the CDN url
    }
  }
}

/** Localize a bookmark and (one level) its quoted tweet's media. */
export async function localizeBookmarkMedia(
  bookmark: Bookmark,
  attachmentsFolder: string,
  io: MediaIO
): Promise<void> {
  await localizeMedia(bookmark.tweetId, bookmark.media, attachmentsFolder, io);
  if (bookmark.quoted) {
    await localizeMedia(bookmark.quoted.tweetId, bookmark.quoted.media, attachmentsFolder, io);
  }
}
