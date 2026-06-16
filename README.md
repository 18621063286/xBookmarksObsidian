# Obsidian X Bookmarks

Sync your own **Twitter/X bookmarks** into your Obsidian vault as Markdown notes —
one note per bookmark, fully searchable, permanently archived, and consumable by
your other tools. Architecture mirrors
[obsidian-weread-plugin](https://github.com/zhaohongxuan/obsidian-weread-plugin):
embedded web login captures your session cookie, that cookie calls X's internal
GraphQL `Bookmarks` endpoint, and each bookmark is rendered through a Nunjucks
template into `Twitter/`.

> ⚠️ **Unofficial, personal use, your own risk.** This plugin uses X's private
> web API with your own session cookie (no paid API). It only ever **reads your
> own bookmarks** — it never posts, edits, or deletes. X may change its internal
> API at any time. Don't use it for bulk/commercial scraping. Your cookie is
> stored only in this plugin's local `data.json` and is never sent anywhere except
> to x.com.

## Features

- **One-click embedded login** (desktop) — opens X's real login window and grabs
  `auth_token` + `ct0`; no manual cookie hunting. 2FA works because it's the real
  login page.
- **Mobile fallback** — paste a cookie string manually (embedded login is
  desktop-only because it needs Electron).
- **Complete capture** — full text (including >280-char `note_tweet` long-form),
  author + handle + avatar, timestamp, permalink, images/videos/GIFs, **quoted
  tweets** (one level), and external-link cards. Threads are intentionally **not**
  reconstructed.
- **Never overwrites your edits** — dedup is by immutable `tweet_id`. An existing
  note is skipped, never re-written, so any manual annotations are safe. (This is
  the weread pain point this plugin designs around.)
- **Resilient to queryId rotation** — X rotates the Bookmarks `queryId` every few
  weeks. The plugin auto-discovers it from X's JS bundle, caches it, lets you
  override it, and falls back to a static value — and on failure says so clearly
  instead of dying silently.
- **Safe pagination** — hard page cap, no-progress detection, 429 backoff, and
  progress so a sync is interruptible.
- **Manual + scheduled sync**, custom template, custom folder, optional **local
  media download** so notes survive the original tweet being deleted.
- **Ribbon button** (left toolbar): click to sync; right-click for quick actions.
- **Optional AI monthly digest** via your **local Ollama** — summarizes new
  bookmarks by month into a single note (topics, viewpoints, top authors), newest
  on top. Nothing leaves your machine.

## Install

> Network + privacy note: this plugin sends requests to **x.com** with your own
> session cookie (stored only in this plugin's local `data.json`) and, if you
> enable the digest, to your **local Ollama**. It is unofficial and for personal
> use — see the disclaimer at the top.

### Via BRAT (recommended)

1. Install the [**BRAT**](https://github.com/TfTHacker/obsidian42-brat) community plugin.
2. *BRAT → Add beta plugin* → paste this repo's URL.
3. Enable **X Bookmarks** in *Settings → Community plugins*.

### Manual

Copy `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/x-bookmarks-to-vault/`, then enable it in
*Settings → Community plugins*.

### Build from source

```bash
npm install
npm run build   # produces main.js
```

Maintainers: see [PUBLISHING.md](PUBLISHING.md) for releasing and store submission.

## Usage

1. Open **Settings → X Bookmarks**.
2. **Desktop:** click **Log in to X**, log in normally; the window closes itself
   once your credentials are captured.
   **Mobile / fallback:** paste a cookie string containing `auth_token` and `ct0`.
3. Run the command **"Sync X bookmarks"** (Command Palette). Notes appear under
   your configured folder (default `Twitter/`).
4. Optionally enable **Scheduled sync** to sync on an interval.

Commands:

| Command | What it does |
|---|---|
| **Sync X bookmarks** | Pulls new bookmarks; skips ones already saved. |
| **Force re-render all X bookmarks** | Re-renders every fetched bookmark (e.g. after changing your template). Overwrites existing notes. |
| **Log in to X** | Opens the embedded login window (desktop only). |

## Settings

- **Note folder** — where notes are written (default `Twitter`).
- **Custom template** — a Nunjucks template for the note **body** (frontmatter is
  always added automatically so dedup never breaks). See
  [`src/render/default-template.njk`](src/render/default-template.njk) for the
  default to copy from. Available variables: `author.{name,handle,avatar}`,
  `text`, `created_at`, `permalink`, `media[]`, `quoted`, `card`, `tweet_id`,
  `bookmarked_at`.
- **Download media locally** — save images/videos into `<folder>/_attachments/`.
- **Scheduled sync** + **interval** (minutes).
- **Max pages per sync** — pagination guardrail.
- **Advanced → queryId override / Bearer override** — manual escape hatches if
  auto-discovery ever fails.

## Note format

Each note carries a frontmatter sentinel used for dedup:

```yaml
---
doc_type: "x-bookmark"
tweet_id: "1234567890"
author: "Alice"
handle: "alice"
created: "2018-10-10T20:19:24.000Z"
url: "https://x.com/alice/status/1234567890"
bookmarked_at: "2026-06-16T00:00:00.000Z"
---
```

Filename: `{handle}-{tweet_id}.md` (block-ref-sensitive characters sanitized).

## Troubleshooting

- **"queryId may have rotated" / 404** — X changed its internal API. The plugin
  tries to auto-refresh; if that fails, find the current Bookmarks `queryId` and
  paste it into *Advanced → queryId override*.
- **"session is invalid / expired"** — your cookie expired. Log in again
  (desktop) or paste a fresh cookie (mobile).
- **Rate limited (429)** — wait and re-run; the plugin backs off and your saved
  notes are untouched.

## Development

```bash
npm install
npm test          # vitest — parser, pagination guardrails, queryId, dedup, render, cookies, media
npm run dev       # esbuild watch
npm run build     # typecheck + production bundle
```

The networked seams (parser, queryId extraction, pagination loop, dedup, render,
cookies, media) are pure/injectable and unit-tested against recorded fixtures —
no live X calls in tests. The embedded Electron login is manually tested.

## License

MIT
