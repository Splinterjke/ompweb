// The shell's pre-paint theme script (app/index.html) is the only theme code
// that runs before the bundle. It must know NOTHING about palettes: every
// theme block in globals.css is self-sufficient through `[data-theme="…"]`,
// while a hand-copied palette list drifts and a theme class the bundle does
// not own wins over the user's pick by source order (all preset selectors are
// `html[data-theme="x"], html.theme-x`, equal specificity). Shipped broken
// until 2026-11-08: the script knew 14 of 40 themes and wrote `html.omp` /
// `html.theme-<id>`, so 26 stored themes painted omp Midnight and could not be
// changed at all until a reload — `html.omp` (line 1190) outranks Nord (269).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const { THEME_OPTIONS } = await import("../hooks/useTheme.ts");

const themeScript = async () => {
  const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const boot = scripts.filter((s) => s.includes('"omp-theme"'));
  assert.equal(boot.length, 1, "app/index.html must carry exactly one pre-paint theme script");
  return boot[0];
};

/** Runs the real inline script the way the browser does, for one stored value. */
async function boot({ stored, osDark = false, storageThrows = false } = {}) {
  const script = await themeScript();
  const dom = new JSDOM(
    `<!doctype html><html class="notranslate"><head><meta name="theme-color" content="#000000" /></head><body></body></html>`,
    { url: "http://localhost/", runScripts: "outside-only" },
  );
  const { window } = dom;
  const root = window.document.documentElement;
  // globals.css is not loaded in jsdom; an inline panel color still exercises
  // the script's theme-color tail.
  root.style.setProperty("--bg-panel", "#123456");
  window.matchMedia = (query) => ({ matches: query.includes("dark") && osDark, addEventListener() {}, removeEventListener() {} });
  if (storageThrows) {
    Object.defineProperty(window, "localStorage", { value: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } });
  } else if (stored !== null && stored !== undefined) {
    window.localStorage.setItem("omp-theme", stored);
  }
  window.eval(script);
  return {
    root,
    theme: root.getAttribute("data-theme"),
    classes: Array.from(root.classList),
    themeColor: window.document.querySelector('meta[name="theme-color"]').getAttribute("content"),
  };
}

test("a stored preset theme pre-paints as data-theme only, with no theme class", async () => {
  for (const { id } of THEME_OPTIONS) {
    if (id === "system" || id === "custom") continue;
    const { theme, classes } = await boot({ stored: id, osDark: true });
    assert.equal(theme, id, `${id}: data-theme must be the stored theme`);
    assert.ok(!classes.includes("omp"), `${id}: must not add the omp Midnight class`);
    assert.ok(!classes.some((c) => c.startsWith("theme-")), `${id}: must not add a theme-* class (${classes})`);
    // The script cannot know which presets are dark, and must not guess: React
    // adds `.dark` on mount (only `--shadow-*` and the native select colors
    // wait that long).
    assert.ok(!classes.includes("dark"), `${id}: .dark belongs to React, not the shell`);
  }
});

test("the themes the old palette list did not know keep their own theme", async () => {
  // Every one of these was forced to `omp` before 2026-11-08.
  for (const id of ["oled", "codex", "sepia", "matcha", "oatmeal", "pine", "navy", "omarchy-monokai", "monokai-pro",
    "monokai-pro-light-sun", "aurora-flow", "dawn-flow", "cosmic-flow", "ocean-flow", "sakura-flow", "bamboo-flow",
    "deepseek", "qwen", "qwen-light"]) {
    const { theme, classes } = await boot({ stored: id });
    assert.equal(theme, id);
    assert.ok(!classes.includes("omp"), `${id} must not render as omp Midnight`);
  }
});

test("system follows the operating system, like hooks/useTheme does", async () => {
  const dark = await boot({ stored: "system", osDark: true });
  assert.equal(dark.theme, null, "system means no data-theme");
  assert.deepEqual(dark.classes, ["notranslate", "dark"]);

  const light = await boot({ stored: "system", osDark: false });
  assert.equal(light.theme, null);
  assert.deepEqual(light.classes, ["notranslate"], "a light system visitor gets no class at all");
});

test("no stored theme follows the operating system instead of omp Midnight", async () => {
  const dark = await boot({ stored: null, osDark: true });
  assert.equal(dark.theme, null);
  assert.ok(dark.classes.includes("dark"));
  assert.ok(!dark.classes.includes("omp"));

  const light = await boot({ stored: null, osDark: false });
  assert.equal(light.theme, null);
  assert.ok(!light.classes.includes("dark"));
});

test("custom waits for the bundle instead of painting a palette it cannot know", async () => {
  const { theme, classes } = await boot({ stored: "custom", osDark: true });
  assert.equal(theme, null, "the custom palette lives in inline variables only React can write");
  assert.ok(!classes.includes("omp"));
});

test("a malformed stored value paints nothing and cannot reach the DOM", async () => {
  for (const junk of ['x"><img src=1 onerror=1>', "AURORA", "aurora flow", "aurora_flow", "-nord", "x".repeat(64), "0"]) {
    const { theme, classes } = await boot({ stored: junk, osDark: false });
    assert.equal(theme, null, `${junk}: no data-theme`);
    assert.deepEqual(classes, ["notranslate"]);
  }
});

test("an unusable localStorage still paints the system theme", async () => {
  const { theme, classes } = await boot({ storageThrows: true, osDark: true });
  assert.equal(theme, null);
  assert.ok(classes.includes("dark"));
});

test("the script keeps publishing --bg-panel to the theme-color meta", async () => {
  const { themeColor } = await boot({ stored: "nord" });
  assert.equal(themeColor, "#123456");
});
