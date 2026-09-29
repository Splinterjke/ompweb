import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

// React only ships `act` in its development build; force NODE_ENV before any
// React module is loaded so these tests work regardless of the environment's
// default (production builds throw "act(...) is not supported").
process.env.NODE_ENV = "test";
const React = (await import("react")).default;
const { act, cleanup, fireEvent, render, screen } = await import("@testing-library/react/pure.js");
const { createJiti } = await import("jiti");

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView } = await jiti.import("./MessageView.tsx");

afterEach(cleanup);

test("expanded oversized user message can be collapsed again", (t) => {
  // Layout stub: capped bubbles overflow; an uncapped bubble fits its content.
  const observers = [];
  const originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  };
  const proto = window.HTMLElement.prototype;
  const scrollHeight = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
  const clientHeight = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get() { return 1000; } });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get() { return this.style.maxHeight === "none" ? 1000 : 300; },
  });
  t.after(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    for (const [name, descriptor] of [["scrollHeight", scrollHeight], ["clientHeight", clientHeight]]) {
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else delete proto[name];
    }
  });

  const view = render(React.createElement(MessageView, { message: { role: "user", content: "long\n\n".repeat(200) } }));
  const resize = () => act(() => { for (const observer of observers) observer.callback([]); });
  fireEvent.click(view.getByRole("button", { name: "Show full input" }));
  resize();
  const toggle = view.getByRole("button", { name: "Collapse input" });
  toggle.focus();
  fireEvent.click(toggle);
  // Before re-measuring, the same toggle must stay mounted and focused.
  assert.equal(document.activeElement, toggle);
  resize();
  assert.equal(view.getByRole("button", { name: "Show full input" }), toggle);
  assert.equal(document.activeElement, toggle);
});
