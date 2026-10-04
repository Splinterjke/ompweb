import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const settingsConfigSource = await readFile(new URL("./SettingsConfig.tsx", import.meta.url), "utf8");

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
  return match ? match[1] : "";
}

// The local settings surface styles its shell inline (no .settings-content /
// .settings-body classes exist in globals.css), so the anchors are extracted
// from the SettingsConfig source instead of the stylesheet.
function inlineStyleObject(declaration) {
  const at = settingsConfigSource.indexOf(declaration);
  assert.notEqual(at, -1, `source anchor missing: ${declaration}`);
  const start = settingsConfigSource.lastIndexOf("{", at);
  const end = settingsConfigSource.indexOf("}", at);
  return settingsConfigSource.slice(start, end + 1);
}

// Regression cover for issue #56 ("Extensions & Tools" cannot be scrolled): a
// tabpanel that is itself a height-bounded scroller (`height: 100%` +
// `min-height: 0` + `overflow-y: auto`) nested inside the scrollable content
// column clips instead of overflowing — because as a column flex container its
// overflow:hidden section children shrink to fit, so panel.scrollHeight ===
// panel.clientHeight and neither the panel nor the content column has anything
// to scroll. Exactly one element in the chain may own the scroll, and panels
// must stay unbounded.
test("the settings content column is the single scroller of the tab surface", () => {
  const content = inlineStyleObject("const contentStyle = useMemo(() => ({");
  assert.match(content, /overflowY: "auto"/, "the content column must stay the scroller");
  assert.match(content, /flex: 1/, "the content column must grow inside the body row");
  assert.match(content, /minHeight: 0/, "the content column must be shrinkable, not auto-minimum sized");

  const body = inlineStyleObject('flexDirection: isMobile ? "column" : "row"');
  assert.match(body, /overflow: "hidden"/, "the body row must clip instead of growing");
  assert.match(body, /minHeight: 0/);
  assert.match(body, /flex: 1/);
});

test("settings panels keep their natural height inside the scroller", () => {
  const panel = ruleBody(".settings-panel-inner");
  assert.match(panel, /flex-shrink:\s*0/, "panels must keep their natural height");
  assert.doesNotMatch(panel, /(^|[;\s])height\s*:/, ".settings-panel-inner must not declare a height");
  assert.doesNotMatch(panel, /overflow/, ".settings-panel-inner must not clip its own content");
});

test("no settings tabpanel binds itself to the content height or owns a scroller", () => {
  const panels = settingsConfigSource.match(/<div[^>]*role="tabpanel"[\s\S]*?>/g) ?? [];
  assert.ok(panels.length >= 12, `expected the settings tabpanels, found ${panels.length}`);
  for (const panel of panels) {
    assert.match(panel, /className="settings-panel-inner"/, `tabpanel must carry the shrink-immune class: ${panel}`);
    assert.doesNotMatch(panel, /(^|[^-\w])height\s*:\s*"/, `tabpanel must not set an explicit height: ${panel}`);
    // `overflowX: "hidden"` is a horizontal clip, not a vertical scroller; it
    // cannot reintroduce #56, so it is allowed. Everything else that could own
    // the vertical scroll is forbidden.
    const withoutHorizontalClips = panel.replace(/overflowX: "hidden"/g, "");
    assert.doesNotMatch(withoutHorizontalClips, /overflow/, `tabpanel must not own scrolling: ${panel}`);
  }
});
