# Publishing X Bookmarks

> Replace every `YOUR_GITHUB_USERNAME` and `YOUR_REPO_NAME` below with your real
> values. (Tell the assistant your GitHub username and it will fill these in.)

## Heads-up on the official store

This plugin uses X's **private/unofficial API** with your session cookie and an
**Electron `BrowserWindow`** for login. Both are things the Obsidian review team
scrutinizes, so official-store approval is uncertain. **BRAT** (below) is the
reliable distribution path and needs no review.

## 0. One-time repo setup

1. Create a **public** GitHub repo (e.g. `YOUR_REPO_NAME`).
2. Push this code:
   ```bash
   git remote add origin https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPO_NAME.git
   git push -u origin master
   ```
3. Confirm `.github/workflows/release.yml` is present (it is) — it builds and
   attaches `main.js` / `manifest.json` / `styles.css` on every version tag.

## 1. Cut a release

```bash
git tag 0.1.0          # must equal "version" in manifest.json
git push origin 0.1.0
```

The workflow creates a GitHub Release `0.1.0` with the three asset files. To
release a new version later: bump `version` in `manifest.json` (and add the
`version: minAppVersion` pair to `versions.json`), commit, then tag + push again.

## 2a. Distribute via BRAT (recommended, no review)

Users do this:
1. Install the **BRAT** community plugin.
2. *BRAT → Add beta plugin* → paste `https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPO_NAME`.
3. Enable **X Bookmarks**.

Put that in your README and you're done.

## 2b. Submit to the official community store (optional)

1. Make sure a Release exists (step 1) and the README documents network use +
   cookie storage (it does).
2. Fork **https://github.com/obsidianmd/obsidian-releases**.
3. Edit **`community-plugins.json`** and append this entry (keep the file valid
   JSON — add a comma after the previous entry):

   ```json
   {
     "id": "x-bookmarks",
     "name": "X Bookmarks",
     "author": "Ken",
     "description": "Sync your X/Twitter bookmarks into your vault as Markdown, with optional local-AI monthly summaries.",
     "repo": "YOUR_GITHUB_USERNAME/YOUR_REPO_NAME"
   }
   ```

4. Open a PR. An automated bot validates `manifest.json`, the release assets, the
   `id` (must be unique, no "obsidian"), etc. Then a maintainer reviews manually.
5. Respond to review feedback until approved (or declined — in which case stay on
   BRAT).

References:
- Submission guide: https://docs.obsidian.md/Plugins/Releases/Submit+your+plugin
- Developer policies: https://docs.obsidian.md/Developer+policies
