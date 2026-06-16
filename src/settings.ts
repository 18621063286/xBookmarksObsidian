import { App, PluginSettingTab, Setting, Platform } from "obsidian";
import type XBookmarksPlugin from "./main";
import { parseCookieString, validateCredentials } from "./auth/cookies";

export interface QueryIdCache {
  value: string;
  fetchedAt: number; // epoch ms
}

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
  queryIdCache: QueryIdCache | null;

  /** Scheduled sync. */
  scheduledSyncEnabled: boolean;
  scheduledSyncInterval: number; // minutes

  /** Download media into the vault instead of hot-linking the CDN. */
  downloadMedia: boolean;

  /** Pagination guardrails. */
  maxPages: number;

  /** Resumable-sync progress + bookkeeping. */
  lastSyncCursor: string;
  lastSyncAt: string;
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
  lastSyncCursor: "",
  lastSyncAt: "",
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

  constructor(app: App, plugin: XBookmarksPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "X Bookmarks" });

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
      .setClass("x-bookmarks-setting-cookie")
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
      .setClass("x-bookmarks-setting-cookie")
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

    // --- Advanced ---
    containerEl.createEl("h3", { text: "Advanced" });

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
