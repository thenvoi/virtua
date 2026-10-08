import { NULL } from "./utils.js";

/**
 * @internal
 */
export const isBrowser = typeof window !== "undefined";

/**
 * @internal
 */
export const getCurrentDocument = (node: HTMLElement): Document =>
  node.ownerDocument;

/**
 * @internal
 */
export const getCurrentWindow = (doc: Document) => doc.defaultView!;

let isIOS: boolean | undefined;

/**
 * Currently, all browsers on iOS/iPadOS are WebKit, including WebView.
 * @internal
 */
export const isIOSWebKit = (): boolean => {
  if (isIOS == NULL) {
    isIOS =
      /iP(hone|od|ad)/.test(navigator.userAgent) ||
      // Modern iPad detection (iPadOS 13+)
      // iPadOS 13+ reports the same userAgent/platform information as macOS, to enable desktop sites.
      // So we treat devices that have macOS like information but with touch support as iPadOS.
      // https://stackoverflow.com/questions/57776001/how-to-detect-ipad-pro-as-ipad-using-javascript
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 0);
  }
  return isIOS;
};

let webkit: boolean | undefined;

/**
 * True for every WebKit engine, not only iOS.
 *
 * WebKit reverts a `scrollTop` written while it is running a scroll gesture, so
 * the virtualizer must park its size corrections until the gesture ends. The
 * upstream {@link isIOSWebKit} check exists for that reason, but it only matches
 * iPhone/iPad user agents and iPads masquerading as macOS. A Tauri desktop app
 * runs WKWebView, which has the same behaviour yet reports neither, so
 * corrections were written mid-gesture and the feed visibly jumped as a flick
 * decelerated (FORK-CHANGES.md delta 1; Band issue F7, re-added in v0.53.3-jam.2
 * after the owner's 120Hz A/B showed upstream's relative-write fix insufficient
 * on deceleration).
 *
 * Chromium and Edge include `AppleWebKit` in their user agent for legacy
 * reasons, so they must be excluded explicitly.
 *
 * @internal
 */
export const isWebKit = (): boolean => {
  if (webkit == NULL) {
    const ua = navigator.userAgent;
    webkit = /AppleWebKit/.test(ua) && !/Chrom(e|ium)|Edg\//.test(ua);
  }
  return webkit;
};
