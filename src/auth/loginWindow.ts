import { Platform } from "obsidian";
import type { Credentials } from "./cookies";

/**
 * Embedded X login via an Electron BrowserWindow (KTD1, mirrors weread's
 * wereadLoginModel). Desktop-only; Electron is reached through `window.require`
 * (Electron's renderer require), which is absent on mobile — so this module is
 * import-safe everywhere. (A static `import()`/`require()` is wrong here: esbuild's
 * CJS interop wraps the module under `.default`, so `.remote`/`.BrowserWindow`
 * come back undefined and the window never opens.)
 */

interface RemoteLike {
  BrowserWindow: ElectronBrowserWindowCtor;
}

function electronRequire(): ((mod: string) => unknown) | undefined {
  return (window as unknown as { require?: (mod: string) => unknown }).require;
}

function getRemote(): RemoteLike | null {
  const req = electronRequire();
  if (!req) return null;
  // Electron <14 exposed `remote` on the core module; newer builds use @electron/remote.
  try {
    const electron = req("electron") as { remote?: RemoteLike };
    if (electron.remote?.BrowserWindow) return electron.remote;
  } catch {
    /* ignore */
  }
  try {
    const remote = req("@electron/remote") as RemoteLike;
    if (remote.BrowserWindow) return remote;
  } catch {
    /* ignore */
  }
  return null;
}

export interface LoginOptions {
  /** Override for testing/diagnostics. */
  loginUrl?: string;
}

const DEFAULT_LOGIN_URL = "https://x.com/i/flow/login";

/**
 * Open the X login flow in a child window and resolve once both `auth_token`
 * and `ct0` cookies are present. Rejects if the window is closed first or the
 * platform can't host it.
 */
export async function loginAndCaptureCookies(opts: LoginOptions = {}): Promise<Credentials> {
  if (!Platform.isDesktopApp) {
    throw new Error("Embedded login is desktop-only. On mobile, paste your cookie manually in settings.");
  }

  const remote = getRemote();
  if (!remote?.BrowserWindow) {
    throw new Error(
      "Could not access Electron BrowserWindow (remote unavailable in this Obsidian build). " +
        "Use the manual cookie-paste fallback in settings."
    );
  }

  const { BrowserWindow } = remote;

  return new Promise<Credentials>((resolve, reject) => {
    const win = new BrowserWindow({
      width: 600,
      height: 800,
      show: true,
      title: "Log in to X",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: "persist:x-bookmarks-login",
      },
    });

    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        win.removeAllListeners("closed");
        win.close();
      } catch {
        /* ignore */
      }
      fn();
    };

    const tryCapture = async () => {
      if (settled) return;
      try {
        const session = win.webContents.session;
        // Query both the host and leading-dot domain forms; the same cookie name
        // can appear in both result sets (weread prior art). Dedup by name.
        const byName = new Map<string, string>();
        const filters: Record<string, string>[] = [
          { url: "https://x.com" },
          { domain: ".x.com" },
          { domain: "x.com" },
        ];
        for (const filter of filters) {
          let cookies: ElectronCookie[] = [];
          try {
            cookies = await session.cookies.get(filter);
          } catch {
            continue;
          }
          for (const c of cookies) {
            if (!byName.has(c.name) && c.value) byName.set(c.name, decode(c.value));
          }
        }
        const authToken = byName.get("auth_token");
        const ct0 = byName.get("ct0");
        if (authToken && ct0) {
          settle(() => resolve({ authToken, ct0 }));
        }
      } catch {
        /* keep waiting for the next navigation */
      }
    };

    // Use navigation (not did-finish-load) so we don't capture mid-flow partial state.
    win.webContents.on("did-navigate", (_e: unknown, url: string) => {
      if (isLandedUrl(url)) void tryCapture();
    });
    win.webContents.on("did-navigate-in-page", (_e: unknown, url: string) => {
      if (isLandedUrl(url)) void tryCapture();
    });

    win.on("closed", () => {
      if (!settled) {
        settled = true;
        reject(new Error("Login window was closed before credentials were captured."));
      }
    });

    win.loadURL(opts.loginUrl ?? DEFAULT_LOGIN_URL).catch((err: unknown) => {
      // ERR_ABORTED fires when our own navigation-capture interrupts the load —
      // benign. Surface anything else as a clean rejection instead of an
      // unhandled promise rejection in the console.
      const msg = err instanceof Error ? err.message : String(err);
      if (/ERR_ABORTED/.test(msg)) return;
      if (!settled) {
        settled = true;
        try {
          win.removeAllListeners("closed");
          win.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`Failed to load the X login page: ${msg}. Check your network/VPN and try again.`));
      }
    });
  });
}

/** Cookie values can arrive percent-encoded; decode defensively. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** True once the browser has navigated past the login flow into the app. */
function isLandedUrl(url: string): boolean {
  if (!url) return false;
  return /:\/\/(x|twitter)\.com\/(home|i\/|messages|notifications)/.test(url) || /\/home$/.test(url);
}
