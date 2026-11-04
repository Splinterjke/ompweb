import assert from "node:assert/strict";
import test from "node:test";

const { nextThemePreference, resolveTheme } = await import("./useTheme.ts");

test("cycles explicit and system theme preferences", () => {
  assert.equal(nextThemePreference("light"), "dark");
  assert.equal(nextThemePreference("dark"), "system");
  assert.equal(nextThemePreference("system"), "light");
});

test("resolves system theme from the operating system preference", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});


// The PWA chrome sync (upstream ebaae186): the exported writer is what the
// module feeds the live --bg-panel into; jsdom applies no app stylesheet, so
// the writer itself is the contract worth pinning.
await import("../tests/setup-dom.mjs");
const { applyThemeChrome } = await import("./useTheme.ts");

test("applyThemeChrome publishes a plain hex to the meta, cookie and manifest href, and refuses anything else", () => {
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = "#000000";
  const manifest = document.createElement("link");
  manifest.rel = "manifest";
  manifest.href = "/api/manifest";
  document.head.append(meta, manifest);
  try {
    assert.equal(applyThemeChrome("#21222C"), true);
    assert.equal(meta.getAttribute("content"), "#21222C");
    assert.match(document.cookie, /(^|; )omp-theme-color=21222C(;|$)/);
    // A new href makes Chrome drop its cached manifest and refetch the new color.
    assert.equal(manifest.getAttribute("href"), "/api/manifest?theme=21222C");
    // A custom theme's color-mix panel: no chrome change, the old color stays.
    assert.equal(applyThemeChrome("color-mix(in srgb, #21222C 82%, white 4%)"), false);
    assert.equal(meta.getAttribute("content"), "#21222C");
    assert.equal(manifest.getAttribute("href"), "/api/manifest?theme=21222C");
  } finally {
    meta.remove();
    manifest.remove();
  }
});
