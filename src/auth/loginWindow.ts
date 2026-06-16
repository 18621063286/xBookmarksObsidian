import { Platform } from "obsidian";
import type { Credentials } from "./cookies";

/**
 * Embedded X login via an Electron BrowserWindow (KTD1, mirrors weread's
 * wereadLoginModel). Desktop-only; Electron is lazy-`require`d inside the
 * function so this module is import-safe on mobile and in tests.
 */

function getRemote(): any {
  // Obsidian historically exposes electron's remote on the sandboxed require.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron");
    if (electron?.remote?.BrowserWindow) return electron.remote;
  } catch {
    /* ignore */
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const remote = require("@electron/remote");
    if (remote?.BrowserWindow) return remote;
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
export function loginAndCaptureCookies(opts: LoginOptions = {}): Promise<Credentials> {
  if (!Platform.isDesktopApp) {
    return Promise.reject(
      new Error("Embedded login is desktop-only. On mobile, paste your cookie manually in settings.")
    );
  }

  const remote = getRemote();
  if (!remote?.BrowserWindow) {
    return Promise.reject(
      new Error(
        "Could not access Electron BrowserWindow (remote unavailable in this Obsidian build). " +
          "Use the manual cookie-paste fallback in settings."
      )
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
        for (const filter of [{ url: "https://x.com" }, { domain: ".x.com" }, { domain: "x.com" }]) {
          let cookies: any[] = [];
          try {
            cookies = await session.cookies.get(filter as any);
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

    win.loadURL(opts.loginUrl ?? DEFAULT_LOGIN_URL).catch((err: any) => {
      // ERR_ABORTED fires when our own navigation-capture interrupts the load —
      // benign. Surface anything else as a clean rejection instead of an
      // unhandled promise rejection in the console.
      const msg = String(err?.message ?? err);
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
