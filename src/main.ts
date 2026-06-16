import { Plugin, Notice, Platform, addIcon } from "obsidian";
import {
  XBookmarksSettings,
  mergeSettings,
  XBookmarksSettingTab,
} from "./settings";
import { loginAndCaptureCookies } from "./auth/loginWindow";
import { SyncEngine } from "./sync/syncEngine";

export default class XBookmarksPlugin extends Plugin {
  settings!: XBookmarksSettings;
  private scheduleId: number | null = null;
  private syncing = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Custom X logo for the ribbon (the path is in a 24x24 box, scaled to 100).
    addIcon(
      "x-bookmarks-logo",
      `<path fill="currentColor" transform="scale(4.1667)" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>`
    );
    this.addRibbonIcon("x-bookmarks-logo", "Sync X bookmarks", () => this.runSync());

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
    // Managed manually (cleared on reconfigure + onunload) rather than via
    // registerInterval, because the interval must be replaceable at runtime —
    // registerInterval would accumulate orphaned handles on each reconfigure.
    this.scheduleId = window.setInterval(() => this.runSync(), ms);
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

  async runSync(opts: { force?: boolean } = {}): Promise<void> {
    if (this.syncing) {
      new Notice("X bookmark sync already in progress…");
      return;
    }
    this.syncing = true;
    try {
      const engine = new SyncEngine({
        app: this.app,
        settings: this.settings,
        saveSettings: () => this.saveSettings(),
        notify: (msg) => new Notice(msg),
      });
      await engine.run(opts);
    } catch (e) {
      new Notice(`X bookmark sync error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.syncing = false;
    }
  }
}
