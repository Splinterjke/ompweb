import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { readFile } from "node:fs/promises";

// React only ships `act` in its development build; force NODE_ENV before any
// React module is loaded so these tests work regardless of the environment's
// default (production builds throw "act(...) is not supported").
process.env.NODE_ENV = "test";
const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react/pure.js");
const { createJiti } = await import("jiti");

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ExtensionDialog, shouldDeferAttachedFocus } = await jiti.import("./ExtensionDialog.tsx");
const { MOBILE_QUERY } = await jiti.import("@/hooks/useIsMobile");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

const OPTIONS = [
  { label: "Red" },
  { label: "Green", preview: "green:\n  hue: 120\n  token: veryLongPreviewTokenWithoutAnyBreakOpportunity" },
];

function askRequest(questions = [{ id: "color", header: "Color", question: "Pick a color", options: OPTIONS, recommended: 1 }]) {
  return { type: "extension_ui_request", id: "ask-1", method: "ask", questions };
}

/** Renders the composer-attached panel — the mobile path these fixes cover. */
function renderAttached(request = askRequest(), attached = true) {
  const responses = [];
  const view = render(React.createElement(ExtensionDialog, {
    request,
    onRespond: (_request, response) => responses.push(response),
    attached,
  }));
  return { responses, view };
}

function staticMarkup(request = askRequest(), props = {}) {
  return renderToStaticMarkup(React.createElement(ExtensionDialog, {
    request,
    onRespond: () => {},
    attached: true,
    ...props,
  }));
}

/** Stubs the media queries the panel reads, the way the ChatInput tests do. */
function stubMedia({ coarse = false, fine = false, narrow = false } = {}) {
  const original = window.matchMedia;
  window.matchMedia = (query) => ({
    matches: query === "(pointer: coarse)"
      ? coarse
      : query === "(pointer: fine)"
        ? fine
        : query === MOBILE_QUERY
          ? narrow
          : false,
    addEventListener() {},
    removeEventListener() {},
  });
  return () => {
    if (original) window.matchMedia = original;
    else delete window.matchMedia;
  };
}

/** Stubs the visual viewport: a `height` below the window height means the
 * on-screen keyboard covers part of the visible area. `undefined` removes the
 * API entirely, which is what SSR and jsdom see. */
function stubVisualViewport(height) {
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  if (height !== undefined) {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        height,
        addEventListener() {},
        removeEventListener() {},
      },
    });
  } else {
    delete window.visualViewport;
  }
  return () => {
    if (original) Object.defineProperty(window, "visualViewport", original);
    else delete window.visualViewport;
  };
}

let restoreMedia = () => {};
let restoreViewport = () => {};

beforeEach(() => {
  // jsdom has no matchMedia and no visualViewport: the default is the
  // desktop-without-a-keyboard case (except `fine`, which jsdom also cannot
  // answer, so tests that care about it stub it explicitly).
  restoreMedia = stubMedia({ fine: true });
  restoreViewport = stubVisualViewport(undefined);
});

afterEach(() => {
  cleanup();
  restoreMedia();
  restoreViewport();
});

// ---- #234: horizontal overflow ------------------------------------------------

test("both ask grids pin their column so a wide question cannot stretch the panel", () => {
  const html = staticMarkup();
  // An implicit `grid-template-columns: none` sizes its track by max-content,
  // so one long unwrapped question makes the panel wider than the composer
  // column and the phone clips the option rows at the right edge (#234).
  const grids = html.match(/grid-template-columns:minmax\(0, 1fr\)/g) ?? [];
  assert.equal(grids.length, 2, "the questions grid and each question's fieldset");
  assert.equal((html.match(/<fieldset [^>]*min-width:0/g) ?? []).length, 1);
  assert.match(html, /<div style="padding:14px">/);
});

test("the option row, its text and its preview cannot push past the panel edge", () => {
  const html = staticMarkup();
  // The label is a flex row inside the fieldset's grid: it needs a zero
  // minimum and wrapping text of its own, otherwise a long option label or
  // preview keeps the track at min-content and overflows.
  assert.match(html, /<label style="[^"]*display:flex[^"]*min-width:0[^"]*"/);
  assert.match(html, /<span style="min-width:0;overflow-wrap:anywhere">Red/);
  // A preview used to be `white-space: pre` + `overflow-x: auto`, which turns
  // every option row into its own horizontal scroller.
  assert.match(html, /font-family:var\(--font-mono\)[^"]*white-space:pre-wrap;overflow-wrap:anywhere">green:/);
  assert.doesNotMatch(html, /overflow-x:auto/);
});

test("the panel, its scroller and the Other textarea can shrink inside the column", () => {
  const html = staticMarkup();
  assert.match(html, /role="dialog"[^>]*style="[^"]*box-sizing:border-box;min-width:0/);
  assert.match(html, /class="extension-dialog-content" style="[^"]*min-width:0/);
  assert.match(html, /aria-label="Other \(type your answer\)"[\s\S]{0,400}box-sizing:border-box;min-width:0/);
});

// ---- #235: composer-attached focus --------------------------------------------

test("touch input and phone widths defer focus; a physical desktop keeps it", () => {
  const cases = [
    [{ coarse: true }, true, "phone"],
    [{ coarse: true, narrow: true }, true, "phone with a fine-pointer report"],
    [{ narrow: true }, true, "phone whose pointer queries never match"],
    [{ fine: true, narrow: true }, true, "narrow window: same width as a phone"],
    [{ fine: true }, false, "desktop"],
    [{}, true, "a browser that answers neither query does not claim a keyboard"],
  ];
  for (const [media, expected, label] of cases) {
    const restore = stubMedia(media);
    try {
      assert.equal(shouldDeferAttachedFocus(), expected, label);
    } finally {
      restore();
    }
  }
});

test("a page without matchMedia at all keeps the keyboard focus path", () => {
  const original = window.matchMedia;
  delete window.matchMedia;
  try {
    assert.equal(shouldDeferAttachedFocus(), false);
  } finally {
    if (original) window.matchMedia = original;
  }
});

test("a composer-attached request on a touch device does not open the keyboard", async () => {
  const restore = stubMedia({ coarse: true });
  try {
    renderAttached();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const other = screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea");
    assert.notEqual(document.activeElement, other);
  } finally {
    restore();
  }
});

// ---- #236: the submit affordance ----------------------------------------------

test("an open keyboard caps the panel to the visible area and reveals the send button", () => {
  const viewportHeight = Math.round(window.innerHeight * 0.5);
  const restore = stubVisualViewport(viewportHeight);
  try {
    renderAttached();
    const panel = screen.getByRole("dialog");
    assert.equal(panel.style.maxHeight, "min(420px, 60dvh)", "no keyboard: the CSS cap stands");
    assert.equal(screen.queryByRole("button", { name: "Submit answer" }), null);

    fireEvent.focus(screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea"));
    assert.equal(panel.style.maxHeight, `${viewportHeight - 12}px`, "the footer must stay inside the visible area");
    assert.ok(screen.getByRole("button", { name: "Submit answer" }), "the answer can be sent from the keyboard");
  } finally {
    restore();
  }
});

test("the keyboard-only footer cap applies to every attached method", () => {
  const viewportHeight = Math.round(window.innerHeight * 0.5);
  const restore = stubVisualViewport(viewportHeight);
  const restoreMedia = stubMedia({ coarse: true });
  try {
    const { responses } = renderAttached({ type: "extension_ui_request", id: "select-1", method: "select", title: "Which?", options: ["First", "Second"] });
    const button = screen.getByRole("button", { name: "First" });
    fireEvent.click(button);
    fireEvent.focus(button);
    assert.equal(screen.getByRole("dialog").style.maxHeight, `${viewportHeight - 12}px`);
    assert.deepEqual(responses, [], "select still submits from the footer, not from focus");
  } finally {
    restoreMedia();
    restore();
  }
});

test("the inline send button submits the same answer as the footer", () => {
  const restore = stubVisualViewport(Math.round(window.innerHeight * 0.5));
  try {
    const { responses } = renderAttached();
    const other = screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea");
    fireEvent.focus(other);
    fireEvent.change(other, { target: { value: " Teal " } });
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    assert.deepEqual(responses, [{ answers: [{ id: "color", selectedOptions: [], customInput: "Teal" }] }]);
  } finally {
    restore();
  }
});

test("the inline send button keeps the footer's canSubmit rule", () => {
  const restore = stubVisualViewport(Math.round(window.innerHeight * 0.5));
  try {
    const { responses } = renderAttached(askRequest([{ id: "size", question: "Pick a size", options: [{ label: "S" }, { label: "M" }] }]));
    fireEvent.focus(screen.getByRole("group", { name: /Pick a size/ }).querySelector("textarea"));
    const send = screen.getByRole("button", { name: "Submit answer" });
    assert.equal(send.disabled, true);
    fireEvent.click(send);
    assert.deepEqual(responses, [], "an unanswered single-select question cannot be submitted");
    assert.equal(screen.getByRole("button", { name: "Submit" }).disabled, true, "the footer agrees");
  } finally {
    restore();
  }
});

test("without a visible-area API the panel keeps its CSS cap", () => {
  const { responses } = renderAttached();
  const panel = screen.getByRole("dialog");
  assert.equal(panel.style.maxHeight, "min(420px, 60dvh)");
  const other = screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea");
  fireEvent.focus(other);
  fireEvent.change(other, { target: { value: "Teal" } });
  assert.equal(panel.style.maxHeight, "min(420px, 60dvh)");
  assert.equal(screen.queryByRole("button", { name: "Submit answer" }), null, "no keyboard signal, no extra control");
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [{ answers: [{ id: "color", selectedOptions: [], customInput: "Teal" }] }]);
});

// ---- touch targets (globals.css) ----------------------------------------------

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

test("the dialog footer and inline send button scale with the touch-target preference", () => {
  assert.match(
    ruleBody('html[data-touch-targets="accessible"] :is(.extension-dialog-footer > button, .extension-dialog-send)'),
    /min-height:\s*44px/,
  );
  assert.match(ruleBody('html[data-touch-targets="accessible"] .extension-dialog-send'), /min-width:\s*44px/);
  assert.match(
    css,
    /@media \(max-width: 640px\) and \(pointer: coarse\) and \(hover: none\) \{\s*html:not\(\[data-touch-targets="compact"\]\):not\(\[data-touch-targets="accessible"\]\) :is\(\.extension-dialog-footer > button, \.extension-dialog-send\) \{\s*min-height: 40px;/,
  );
});
