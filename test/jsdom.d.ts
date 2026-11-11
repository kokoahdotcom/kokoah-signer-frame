/** The part of jsdom's API the tests use (a second window, for the prompt's confirmation window). */
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { pretendToBeVisual?: boolean; url?: string });
    readonly window: Window & typeof globalThis;
  }
}
