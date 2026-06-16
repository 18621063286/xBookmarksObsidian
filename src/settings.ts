import { App, PluginSettingTab, Setting, Platform, Notice } from "obsidian";
import type XBookmarksPlugin from "./main";
import { parseCookieString, validateCredentials } from "./auth/cookies";
import type { QueryIdCacheEntry } from "./api/queryId";
import { listOllamaModels } from "./ai/ollama";
import { obsidianOllamaRequest } from "./sync/digestEngine";

export interface XBookmarksSettings {
  /** X session credentials (captured via embedded login or pasted manually). */
  authToken: string;
  ct0: string;

  /** Target vault folder for bookmark notes. */
  noteFolder: string;
  /** Custom Nunjucks template. Empty string => use the bundled default. */
  template: string;

  /** Manual override for the Bookmarks GraphQL queryId (wins over discovery). */
  queryIdOverride: string;
  /** Manual override for the static web bearer token (rarely needed). */
  bearerOverride: string;
  /** TTL-cached auto-discovered queryId. */
  queryIdCache: QueryIdCacheEntry | null;

  /** Scheduled sync. */
  scheduledSyncEnabled: boolean;
  scheduledSyncInterval: number; // minutes

  /** Download media into the vault instead of hot-linking the CDN. */
  downloadMedia: boolean;

  /** Pagination guardrails. */
  maxPages: number;

  /** AI digest (local Ollama). */
  aiEnabled: boolean;
  ollamaUrl: string;
  ollamaModel: string;
  /** Digest filename, written in the parent folder of noteFolder. */
  digestFile: string;

  /** Resumable-sync progress + bookkeeping. */
  lastSyncCursor: string;
  lastSyncAt: string;
  /** Set once the full bookmark history has been walked end-to-end. After this,
   *  syncs stop early at the first already-synced bookmark (incremental). */
  backfillComplete: boolean;
}

export const DEFAULT_SETTINGS: XBookmarksSettings = {
  authToken: "",
  ct0: "",
  noteFolder: "Twitter",
  template: "",
  queryIdOverride: "",
  bearerOverride: "",
  queryIdCache: null,
  scheduledSyncEnabled: false,
  scheduledSyncInterval: 60,
  downloadMedia: false,
  maxPages: 50,
  aiEnabled: false,
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "",
  digestFile: "X Bookmarks Digest.md",
  lastSyncCursor: "",
  lastSyncAt: "",
  backfillComplete: false,
};

/**
 * Merge persisted data over the defaults. Kept pure so it can be unit-tested
 * without an Obsidian runtime, and so unknown/missing keys never crash loading.
 */
export function mergeSettings(loaded: Partial<XBookmarksSettings> | null | undefined): XBookmarksSettings {
  return Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
}

export class XBookmarksSettingTab extends PluginSettingTab {
  plugin: XBookmarksPlugin;
  /** Models fetched from Ollama for the dropdown (transient, not persisted). */
  private availableModels: string[] = [];

  constructor(app: App, plugin: XBookmarksPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private async refreshModels(): Promise<void> {
    try {
      new Notice("Fetching Ollama models…");
      this.availableModels = await listOllamaModels(obsidianOllamaRequest, this.plugin.settings.ollamaUrl);
      if (this.availableModels.length === 0) {
        new Notice("No Ollama models found. Run `ollama pull <model>` first.");
      }
      this.display();
    } catch (e) {
      new Notice(`Ollama: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("X Bookmarks").setHeading();

    // --- Account / login ---
    const creds = validateCredentials(this.plugin.settings);
    new Setting(containerEl)
      .setName("Account")
      .setDesc(
        creds.valid
          ? "Logged in — credentials present."
          : "Not logged in. Log in (desktop) or paste your cookie below."
      )
      .addButton((btn) =>
        btn
          .setButtonText(Platform.isDesktopApp ? "Log in to X" : "Login (desktop only)")
          .setDisabled(!Platform.isDesktopApp)
          .onClick(() => this.plugin.runLogin())
      );

    new Setting(containerEl)
      .setName("Paste cookie (fallback)")
      .setDesc(
        "Mobile / manual fallback. Paste a cookie string containing auth_token and ct0."
      )
      .setClass("x-bookmarks-setting-textarea")
      .addTextArea((ta) =>
        ta
          .setPlaceholder("auth_token=...; ct0=...")
          .setValue("")
          .onChange(async (value) => {
            const parsed = parseCookieString(value);
            if (parsed.authToken && parsed.ct0) {
              this.plugin.settings.authToken = parsed.authToken;
              this.plugin.settings.ct0 = parsed.ct0;
              await this.plugin.saveSettings();
              this.display();
            }
          })
      );

    // --- Output ---
    new Setting(containerEl)
      .setName("Note folder")
      .setDesc("Vault folder where bookmark notes are written.")
      .addText((text) =>
        text
          .setPlaceholder("Twitter")
          .setValue(this.plugin.settings.noteFolder)
          .onChange(async (value) => {
            this.plugin.settings.noteFolder = value.trim() || "Twitter";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Custom template")
      .setDesc("Optional Nunjucks template. Leave empty to use the bundled default.")
      .setClass("x-bookmarks-setting-textarea")
      .addTextArea((ta) =>
        ta
          .setValue(this.plugin.settings.template)
          .onChange(async (value) => {
            this.plugin.settings.template = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Download media locally")
      .setDesc(
        "Save images/videos into <folder>/_attachments so notes survive the original tweet being deleted."
      )
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.downloadMedia).onChange(async (value) => {
          this.plugin.settings.downloadMedia = value;
          await this.plugin.saveSettings();
        })
      );

    // --- Sync ---
    new Setting(containerEl)
      .setName("Scheduled sync")
      .setDesc("Automatically sync on an interval while Obsidian is open.")
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.scheduledSyncEnabled)
          .onChange(async (value) => {
            this.plugin.settings.scheduledSyncEnabled = value;
            await this.plugin.saveSettings();
            this.plugin.reconfigureSchedule();
          })
      );

    new Setting(containerEl)
      .setName("Sync interval (minutes)")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.scheduledSyncInterval))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.scheduledSyncInterval = Math.floor(n);
              await this.plugin.saveSettings();
              this.plugin.reconfigureSchedule();
            }
          })
      );

    new Setting(containerEl)
      .setName("Max pages per sync")
      .setDesc("Pagination guardrail — hard cap on how many pages a single sync fetches.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxPages))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.maxPages = Math.floor(n);
              await this.plugin.saveSettings();
            }
          })
      );

    // --- AI digest ---
    new Setting(containerEl).setName("AI digest (local Ollama)").setHeading();

    new Setting(containerEl)
      .setName("Enable AI digest")
      .setDesc(
        "After each sync, summarize new bookmarks by month into a digest note, using your local Ollama. Nothing leaves your machine."
      )
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.aiEnabled).onChange(async (value) => {
          this.plugin.settings.aiEnabled = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (this.plugin.settings.aiEnabled) {
      new Setting(containerEl)
        .setName("Ollama URL")
        .setDesc("Default http://localhost:11434")
        .addText((text) =>
          text.setValue(this.plugin.settings.ollamaUrl).onChange(async (value) => {
            this.plugin.settings.ollamaUrl = value.trim() || "http://localhost:11434";
            await this.plugin.saveSettings();
          })
        );

      const models =
        this.availableModels.length > 0
          ? this.availableModels
          : this.plugin.settings.ollamaModel
          ? [this.plugin.settings.ollamaModel]
          : [];
      new Setting(containerEl)
        .setName("Model")
        .setDesc("Locally installed Ollama model. Click Refresh to load the list.")
        .addDropdown((dd) => {
          if (models.length === 0) dd.addOption("", "— refresh to load —");
          for (const m of models) dd.addOption(m, m);
          dd.setValue(this.plugin.settings.ollamaModel || "");
          dd.onChange(async (value) => {
            this.plugin.settings.ollamaModel = value;
            await this.plugin.saveSettings();
          });
        })
        .addButton((btn) => btn.setButtonText("Refresh").onClick(() => this.refreshModels()));

      new Setting(containerEl)
        .setName("Digest file")
        .setDesc("Markdown file (in the parent folder of your note folder) holding the monthly summaries.")
        .addText((text) =>
          text.setValue(this.plugin.settings.digestFile).onChange(async (value) => {
            this.plugin.settings.digestFile = value.trim() || "X Bookmarks Digest.md";
            await this.plugin.saveSettings();
          })
        );

      new Setting(containerEl)
        .setName("Rebuild digest")
        .setDesc(
          "Re-fetch ALL bookmarks and regenerate the whole digest. Run once to cover bookmarks you synced before enabling AI."
        )
        .addButton((btn) =>
          btn
            .setButtonText("Rebuild now")
            .setCta()
            .onClick(() => this.plugin.rebuildDigest())
        );
    }

    // --- Advanced ---
    new Setting(containerEl).setName("Advanced").setHeading();

    new Setting(containerEl)
      .setName("queryId override")
      .setDesc(
        "If X rotated the Bookmarks queryId and auto-discovery fails, paste the current one here."
      )
      .addText((text) =>
        text
          .setValue(this.plugin.settings.queryIdOverride)
          .onChange(async (value) => {
            this.plugin.settings.queryIdOverride = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Bearer token override")
      .setDesc("Rarely needed; the static web bearer has been stable for years.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.bearerOverride)
          .onChange(async (value) => {
            this.plugin.settings.bearerOverride = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}
