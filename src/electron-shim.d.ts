// Minimal ambient types for the Electron bits this plugin touches on desktop.
// Electron is provided by the Obsidian runtime (external at build time); these
// declarations let us use a typed dynamic import instead of an untyped require.

interface ElectronCookie {
  name: string;
  value: string;
}

interface ElectronCookies {
  get(filter: Record<string, string>): Promise<ElectronCookie[]>;
}

interface ElectronWebContents {
  session: { cookies: ElectronCookies };
  on(event: string, listener: (event: unknown, url: string) => void): void;
}

interface ElectronBrowserWindowInstance {
  webContents: ElectronWebContents;
  on(event: string, listener: () => void): void;
  removeAllListeners(event: string): void;
  close(): void;
  loadURL(url: string): Promise<void>;
}

interface ElectronBrowserWindowCtor {
  new (options: Record<string, unknown>): ElectronBrowserWindowInstance;
}

declare module "electron" {
  export const remote: { BrowserWindow: ElectronBrowserWindowCtor } | undefined;
}

declare module "@electron/remote" {
  export const BrowserWindow: ElectronBrowserWindowCtor;
}
