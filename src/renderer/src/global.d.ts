import type { Api } from '../../preload/index.js';

declare global {
  interface Window {
    api: Api;
    dialog: {
      prompt(opts: { title: string; defaultValue?: string }): Promise<string | null>;
      confirm(opts: { title: string; message: string }): Promise<boolean>;
    };
  }
}

export {};
