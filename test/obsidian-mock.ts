/**
 * Minimal mock of the `obsidian` module surface used by this plugin, so that
 * source modules importing `obsidian` can be loaded inside vitest (node env).
 * Only the shapes actually referenced are implemented.
 */

export class Plugin {
  app: any;
  manifest: any;
  constructor(app?: any, manifest?: any) {
    this.app = app;
    this.manifest = manifest;
  }
  async loadData(): Promise<any> {
    return null;
  }
  async saveData(_data: any): Promise<void> {}
  addCommand(_cmd: any): any {}
  addSettingTab(_tab: any): void {}
  registerInterval(id: number): number {
    return id;
  }
}

export class PluginSettingTab {
  app: any;
  plugin: any;
  containerEl: any = {
    empty() {},
    createEl() {
      return { setText() {} };
    },
  };
  constructor(app?: any, plugin?: any) {
    this.app = app;
    this.plugin = plugin;
  }
  display(): void {}
}

export class Setting {
  constructor(_containerEl?: any) {}
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  setClass() {
    return this;
  }
  addText(cb?: any) {
    cb?.(this.textLike());
    return this;
  }
  addTextArea(cb?: any) {
    cb?.(this.textLike());
    return this;
  }
  addToggle(cb?: any) {
    cb?.({ setValue: () => this, onChange: () => this });
    return this;
  }
  addButton(cb?: any) {
    cb?.({ setButtonText: () => this, setDisabled: () => this, onClick: () => this });
    return this;
  }
  private textLike() {
    const t: any = {
      setPlaceholder: () => t,
      setValue: () => t,
      onChange: () => t,
    };
    return t;
  }
}

export class Notice {
  constructor(public message: string, public timeout?: number) {}
  setMessage(_m: string) {}
  hide() {}
}

export const Platform = {
  isDesktopApp: true,
  isMobile: false,
  isMobileApp: false,
};

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

export class TFile {
  path = "";
  basename = "";
  extension = "";
}

export class TFolder {
  path = "";
  children: any[] = [];
}

export class TAbstractFile {
  path = "";
}

export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

export async function requestUrl(_param: RequestUrlParam | string): Promise<any> {
  throw new Error("requestUrl is not available in tests; inject a fake request function instead.");
}
