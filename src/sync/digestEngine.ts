import { App, normalizePath, requestUrl, TFile } from "obsidian";
import type { XBookmarksSettings } from "../settings";
import type { Bookmark } from "../model/types";
import { ollamaGenerate, type OllamaRequest } from "../ai/ollama";
import {
  type DigestStore,
  bookmarkToRecord,
  addRecords,
  buildMonthPrompt,
  renderMonthSection,
  mergeDigest,
} from "../ai/digest";

/** Obsidian-backed Ollama transport over requestUrl (used by the engine + settings UI). */
export const obsidianOllamaRequest: OllamaRequest = async ({ url, method, headers, body }) => {
  const res = await requestUrl({ url, method, headers, body, throw: false });
  let json: unknown;
  try {
    json = res.json as unknown;
  } catch {
    try {
      json = JSON.parse(res.text) as unknown;
    } catch {
      json = undefined;
    }
  }
  return { status: res.status, json, text: res.text ?? "" };
};

const DIGEST_TITLE = "X 书签月度摘要";

/**
 * Maintains the monthly AI digest: keeps a compact sidecar store of bookmark
 * records, regenerates the months touched by a sync via local Ollama, and merges
 * them into a single digest note (newest month on top). Entirely best-effort.
 */
export class DigestEngine {
  constructor(
    private app: App,
    private settings: XBookmarksSettings,
    private notify: (msg: string) => void,
    private manifestDir: string,
    /** Optional live progress sink (updated in place during long runs). */
    private progress?: (msg: string) => void
  ) {}

  /** Vault-relative path of the digest note (for opening / messaging). */
  get notePath(): string {
    return this.digestPath();
  }

  /** Add this sync's new bookmarks and regenerate only the affected months. */
  async processNewBookmarks(newBookmarks: Bookmark[]): Promise<void> {
    if (!this.settings.aiEnabled || !this.settings.ollamaModel || newBookmarks.length === 0) return;
    const store = await this.loadStore();
    const touched = addRecords(store, newBookmarks.map(bookmarkToRecord));
    await this.saveStore(store);
    await this.regenerate(store, [...touched], false);
  }

  /**
   * Summarize only the bookmarks not yet in the digest store (the gap), then
   * regenerate just the months they fall into. Returns how many were new.
   */
  async digestMissing(allBookmarks: Bookmark[]): Promise<number> {
    if (!this.settings.ollamaModel) {
      this.notify("请先在设置里选择一个 Ollama 模型。");
      return 0;
    }
    const store = await this.loadStore();
    const have = new Set<string>();
    for (const month of Object.keys(store)) for (const r of store[month]) have.add(r.tweetId);

    const missing = allBookmarks.filter((b) => !have.has(b.tweetId));
    if (missing.length === 0) {
      this.notify("没有需要摘要的新书签——全部已处理。");
      return 0;
    }

    this.notify(`发现 ${missing.length} 条未摘要的书签，正在用 Ollama 分析…`);
    const touched = addRecords(store, missing.map(bookmarkToRecord));
    await this.saveStore(store);
    await this.regenerate(store, [...touched], false);
    return missing.length;
  }

  /** Rebuild the entire digest from a full bookmark set (the rebuild command). */
  async rebuildAll(allBookmarks: Bookmark[]): Promise<void> {
    if (!this.settings.ollamaModel) {
      this.notify("请先在设置里选择一个 Ollama 模型。");
      return;
    }
    const store: DigestStore = {};
    addRecords(store, allBookmarks.map(bookmarkToRecord));
    await this.saveStore(store);
    await this.regenerate(store, Object.keys(store), true);
  }

  private async regenerate(store: DigestStore, months: string[], fromScratch: boolean): Promise<void> {
    const order = months.filter((m) => (store[m]?.length ?? 0) > 0).sort((a, b) => b.localeCompare(a));
    if (order.length === 0) return;

    const report = this.progress ?? this.notify;
    let firstWrite = fromScratch; // only the very first write starts from a clean file
    let done = 0;

    for (let i = 0; i < order.length; i++) {
      const month = order[i];
      const records = store[month];
      report(`AI 分析中…  ${i + 1}/${order.length} 个月份  ·  ${month}（${records.length} 条）`);

      let section: { month: string; content: string };
      try {
        const body = await ollamaGenerate(
          obsidianOllamaRequest,
          this.settings.ollamaUrl,
          this.settings.ollamaModel,
          buildMonthPrompt(month, records)
        );
        section = { month, content: renderMonthSection(month, records, body) };
      } catch (e) {
        console.warn(`[x-bookmarks] AI digest failed for ${month}:`, e);
        this.notify(`AI 分析失败（${month}）：${e instanceof Error ? e.message : String(e)}`);
        if (done === 0) return; // nothing written yet — surface the failure
        break; // keep everything written so far
      }

      // Write after EVERY month so the file appears immediately and partial
      // progress is never lost on a long run.
      const base = firstWrite ? "" : await this.readDigest();
      firstWrite = false;
      const merged = mergeDigest(base, [section], {
        title: DIGEST_TITLE,
        model: this.settings.ollamaModel,
        updatedAt: new Date().toISOString(),
      });
      await this.writeDigest(merged);
      done++;
      if (done === 1) this.notify(`摘要文件已创建：${this.digestPath()}（继续分析中…）`);
    }

    this.notify(`AI 摘要完成（${done}/${order.length} 个月份）→ ${this.digestPath()}`);
  }

  // --- file/store io ---

  private storePath(): string {
    return normalizePath(`${this.manifestDir}/digest-store.json`);
  }

  private digestPath(): string {
    const folder = this.settings.noteFolder;
    const slash = folder.lastIndexOf("/");
    const parent = slash === -1 ? "" : folder.slice(0, slash);
    return normalizePath(parent ? `${parent}/${this.settings.digestFile}` : this.settings.digestFile);
  }

  private async loadStore(): Promise<DigestStore> {
    const path = this.storePath();
    try {
      if (await this.app.vault.adapter.exists(path)) {
        return JSON.parse(await this.app.vault.adapter.read(path)) as DigestStore;
      }
    } catch (e) {
      console.warn("[x-bookmarks] failed to read digest store:", e);
    }
    return {};
  }

  private async saveStore(store: DigestStore): Promise<void> {
    await this.app.vault.adapter.write(this.storePath(), JSON.stringify(store));
  }

  private async readDigest(): Promise<string> {
    const f = this.app.vault.getAbstractFileByPath(this.digestPath());
    return f instanceof TFile ? this.app.vault.read(f) : "";
  }

  private async writeDigest(content: string): Promise<void> {
    const path = this.digestPath();
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.app.vault.modify(f, content);
    else await this.app.vault.create(path, content);
  }
}
