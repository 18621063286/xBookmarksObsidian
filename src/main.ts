import { Plugin, Notice, Platform } from "obsidian";
import {
  XBookmarksSettings,
  mergeSettings,
  XBookmarksSettingTab,
} from "./settings";
import { loginAndCaptureCookies } from "./auth/loginWindow";
import { validateCredentials } from "./auth/cookies";

export default class XBookmarksPlugin extends Plugin {
  settings!: XBookmarksSettings;
  private scheduleId: number | null = null;
  private syncing = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new XBookmarksSettingTab(this.app, this));

    this.addCommand({
      id: "sync-x-bookmarks",
      name: "Sync X bookmarks",
      callback: () => this.runSync(),
    });

    this.addCommand({
      id: "force-resync-x-bookmarks",
      name: "Force re-render all X bookmarks",
      callback: () => this.runSync({ force: true }),
    });

    this.addCommand({
      id: "login-x",
      name: "Log in to X",
      callback: () => this.runLogin(),
    });

    this.reconfigureSchedule();
  }

  onunload(): void {
    if (this.scheduleId !== null) window.clearInterval(this.scheduleId);
  }

  async loadSettings(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** (Re)install the scheduled-sync interval based on current settings. */
  reconfigureSchedule(): void {
    if (this.scheduleId !== null) {
      window.clearInterval(this.scheduleId);
      this.scheduleId = null;
    }
    if (!this.settings.scheduledSyncEnabled) return;
    const ms = Math.max(1, this.settings.scheduledSyncInterval) * 60 * 1000;
    this.scheduleId = window.setInterval(() => this.runSync(), ms);
    this.registerInterval(this.scheduleId);
  }

  // --- Wired in later units (U2 login, U7 sync). Stubbed so U1 loads standalone. ---

  async runLogin(): Promise<void> {
    if (!Platform.isDesktopApp) {
      new Notice("Embedded login is desktop-only. Paste your cookie in settings to use X Bookmarks on mobile.");
      return;
    }
    try {
      new Notice("Opening X login…");
      const creds = await loginAndCaptureCookies();
      this.settings.authToken = creds.authToken;
      this.settings.ct0 = creds.ct0;
      await this.saveSettings();
      new Notice("Logged in to X — credentials saved.");
    } catch (e) {
      new Notice(`X login failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async runSync(_opts: { force?: boolean } = {}): Promise<void> {
    new Notice("X bookmark sync is not wired up yet.");
  }
}
