import { JSDOM } from "jsdom";

// Import before Testing Library so its DOM queries bind to this document.
// `bun test --parallel` gives every test file a fresh global, so nothing is torn down.
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "https://omp.test/",
  pretendToBeVisual: true,
});
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  EventTarget: dom.window.EventTarget,
  CustomEvent: dom.window.CustomEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  FocusEvent: dom.window.FocusEvent,
  InputEvent: dom.window.InputEvent,
  MutationObserver: dom.window.MutationObserver,
  localStorage: dom.window.localStorage,
  sessionStorage: dom.window.sessionStorage,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  // Consumers call `window.matchMedia(...)` (useTheme/useIsMobile); jsdom
  // lacks it, so the global alias above is not enough — stamp it on the window.
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
// Consumers reach it as `window.matchMedia` (useTheme's system-theme effect);
// jsdom does not implement matchMedia, so define it on the window itself.
dom.window.matchMedia = globals.matchMedia;
