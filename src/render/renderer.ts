import nunjucks from "nunjucks";
import type { Bookmark } from "../model/types";
import {
  buildFrontmatter,
  serializeFrontmatter,
  sanitizeFilename,
  toIsoDate,
} from "../util/frontmatter";

/**
 * Render a Bookmark to a Markdown note. Frontmatter (with the dedup sentinel) is
 * always prepended by code; the Nunjucks template controls only the note body, so
 * a custom template can never accidentally drop the `tweet_id` dedup key (U6/KTD5).
 *
 * Kept Obsidian-free (Nunjucks only) so it is unit-testable as a pure function.
 *
 * NOTE: `src/render/default-template.njk` is a copy of DEFAULT_TEMPLATE provided as
 * a starting point for users; this constant is the source of truth used at runtime.
 */

export const DEFAULT_TEMPLATE = `# {{ author.name }} (@{{ author.handle }})

{{ text }}
{% if media | length %}
{% for m in media %}{% if m.type == "photo" %}![]({{ m.url }})
{% else %}🎬 [{{ m.type }}]({{ m.url }})
{% endif %}{% endfor %}{% endif %}{% if quoted %}
> **Quoted — {{ quoted.author.name }} (@{{ quoted.author.handle }})**
>
> {{ quoted.text | replace("\\n", "\\n> ") }}
{% for m in quoted.media %}> ![]({{ m.url }})
{% endfor %}> [↗ original]({{ quoted.permalink }})
{% endif %}{% if card %}
**[{{ card.title or card.url }}]({{ card.url }})**
{% if card.desc %}{{ card.desc }}{% endif %}
{% endif %}
---
[↗ Open on X]({{ permalink }}) · {{ created_at | xdate }}
`;

let cachedEnv: nunjucks.Environment | null = null;

function getEnv(): nunjucks.Environment {
  if (cachedEnv) return cachedEnv;
  const env = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: false });
  env.addFilter("xdate", (value: string) => toIsoDate(value).replace("T", " ").slice(0, 16));
  cachedEnv = env;
  return env;
}

export interface RenderResult {
  filename: string;
  content: string;
}

export interface RenderOptions {
  /** ISO timestamp recorded as bookmarked_at. */
  bookmarkedAt: string;
  /** Custom Nunjucks body template; empty/whitespace uses DEFAULT_TEMPLATE. */
  template?: string;
}

export function renderNote(bookmark: Bookmark, opts: RenderOptions): RenderResult {
  const fmBlock = serializeFrontmatter(buildFrontmatter(bookmark, opts.bookmarkedAt));
  const template = opts.template && opts.template.trim() ? opts.template : DEFAULT_TEMPLATE;

  const ctx = {
    tweet_id: bookmark.tweetId,
    text: bookmark.text,
    author: bookmark.author,
    created_at: bookmark.createdAt,
    permalink: bookmark.permalink,
    media: bookmark.media,
    quoted: bookmark.quoted,
    card: bookmark.card,
    bookmarked_at: opts.bookmarkedAt,
  };

  const body = getEnv().renderString(template, ctx).trim();
  const content = `${fmBlock}\n\n${body}\n`;
  return { filename: sanitizeFilename(bookmark.author.handle, bookmark.tweetId), content };
}
