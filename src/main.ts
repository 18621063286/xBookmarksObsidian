import { Plugin, Notice, Platform, addIcon, Menu, TFile } from "obsidian";
import {
  XBookmarksSettings,
  mergeSettings,
  XBookmarksSettingTab,
} from "./settings";
import { loginAndCaptureCookies } from "./auth/loginWindow";
import { SyncEngine } from "./sync/syncEngine";
import { DigestEngine } from "./sync/digestEngine";

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
    const ribbonEl = this.addRibbonIcon("x-bookmarks-logo", "Sync X bookmarks", () => this.runSync());
    // Right-click the ribbon icon -> quick actions menu (incl. Ollama digest).
    ribbonEl.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle("Sync X bookmarks")
          .setIcon("x-bookmarks-logo")
          .onClick(() => this.runSync())
      );
      if (this.settings.aiEnabled) {
        menu.addItem((item) =>
          item
            .setTitle("AI 摘要未处理的书签")
            .setIcon("sparkles")
            .onClick(() => this.digestUndigested())
        );
        menu.addItem((item) =>
          item
            .setTitle("重建全部 AI 摘要")
            .setIcon("refresh-cw")
            .onClick(() => this.rebuildDigest())
        );
      }
      menu.showAtMouseEvent(evt);
    });

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

    this.addCommand({
      id: "digest-undigested",
      name: "AI digest: summarize un-digested bookmarks",
      callback: () => this.digestUndigested(),
    });

    this.addCommand({
      id: "rebuild-ai-digest",
      name: "Rebuild AI digest from all bookmarks",
      callback: () => this.rebuildDigest(),
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
      const newBookmarks = await engine.run(opts);
      if (this.settings.aiEnabled && newBookmarks.length) {
        const progress = new Notice("AI 摘要中…", 0);
        try {
          await this.digestEngine((m) => progress.setMessage(m)).processNewBookmarks(newBookmarks);
        } catch (e) {
          new Notice(`AI digest failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          progress.hide();
        }
      }
    } catch (e) {
      new Notice(`X bookmark sync error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.syncing = false;
    }
  }

  private digestEngine(progress?: (msg: string) => void): DigestEngine {
    return new DigestEngine(
      this.app,
      this.settings,
      (msg) => new Notice(msg),
      this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
      progress
    );
  }

  private async openDigest(path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.app.workspace.getLeaf(true).openFile(f);
  }

  /** Summarize only bookmarks that haven't been added to the digest yet. */
  async digestUndigested(): Promise<void> {
    if (this.syncing) {
      new Notice("A sync/digest is already running…");
      return;
    }
    if (!this.settings.aiEnabled) {
      new Notice("Enable AI digest in settings first.");
      return;
    }
    if (!this.settings.ollamaModel) {
      new Notice("Pick an Ollama model in settings first.");
      return;
    }
    this.syncing = true;
    const progress = new Notice("准备 AI 摘要…", 0);
    try {
      const engine = new SyncEngine({
        app: this.app,
        settings: this.settings,
        saveSettings: () => this.saveSettings(),
        notify: (msg) => progress.setMessage(msg),
      });
      const all = await engine.fetchAllParsed((n) => progress.setMessage(`正在拉取书签…已获取 ${n} 条`));
      if (!all.length) {
        new Notice("No bookmarks fetched.");
        return;
      }
      const de = this.digestEngine((m) => progress.setMessage(m));
      const n = await de.digestMissing(all);
      if (n > 0) await this.openDigest(de.notePath);
    } catch (e) {
      new Notice(`Digest failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      progress.hide();
      this.syncing = false;
    }
  }

  /** Re-fetch all bookmarks and rebuild the monthly AI digest from scratch. */
  async rebuildDigest(): Promise<void> {
    if (this.syncing) {
      new Notice("A sync/digest is already running…");
      return;
    }
    if (!this.settings.aiEnabled) {
      new Notice("Enable AI digest in settings first.");
      return;
    }
    if (!this.settings.ollamaModel) {
      new Notice("Pick an Ollama model in settings first.");
      return;
    }
    this.syncing = true;
    const progress = new Notice("准备重建 AI 摘要…", 0);
    try {
      const engine = new SyncEngine({
        app: this.app,
        settings: this.settings,
        saveSettings: () => this.saveSettings(),
        notify: (msg) => progress.setMessage(msg),
      });
      const all = await engine.fetchAllParsed((n) => progress.setMessage(`正在拉取全部书签…已获取 ${n} 条`));
      if (!all.length) {
        new Notice("No bookmarks fetched.");
        return;
      }
      progress.setMessage(`共 ${all.length} 条，开始用 Ollama 分析（按月，请耐心等待）…`);
      const de = this.digestEngine((m) => progress.setMessage(m));
      await de.rebuildAll(all);
      await this.openDigest(de.notePath);
    } catch (e) {
      new Notice(`Rebuild digest failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      progress.hide();
      this.syncing = false;
    }
  }
}
