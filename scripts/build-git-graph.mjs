// Compile the webview TypeScript, concatenate the emitted scripts in dependency order (bridge first so
// acquireVsCodeApi exists when utils.js initializes; upstream's own order is utils
// first, *.ts alphabetical, main last), and concatenate the stylesheets.
//
// Usage: node scripts/build-git-graph.mjs [--no-tsc]   (--no-tsc reuses build/git-graph-web)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsconfig = path.join(root, "vendor", "vscode-git-graph", "web", "tsconfig.json");
const compiledDir = path.join(root, "build", "git-graph-web", "web");
const stylesDir = path.join(root, "vendor", "vscode-git-graph", "web", "styles");
const outDir = path.join(root, "public", "gitgraph");

// Concatenation order: the bridge defines the host API globals the other files
// consume at top-level; utils.ts must precede everything else (upstream rule);
// main.ts must come last (it instantiates the view).
const JS_ORDER = [
  "ompweb-bridge.js",
  "utils.js",
  "contextMenu.js",
  "dialog.js",
  "dropdown.js",
  "findWidget.js",
  "graph.js",
  "settingsWidget.js",
  "textFormatter.js",
  "main.js",
];
const CSS_ORDER = ["main.css", "contextMenu.css", "dialog.css", "dropdown.css", "findWidget.css", "settingsWidget.css"];

if (!process.argv.includes("--no-tsc")) {
  const tsc = path.join(root, "node_modules", ".bin", "tsc");
  execFileSync(fs.existsSync(tsc) ? tsc : "tsc", ["-p", tsconfig], { stdio: "inherit" });
}

const jsFiles = fs.readdirSync(compiledDir).filter((f) => f.endsWith(".js")).sort();
const missing = JS_ORDER.filter((f) => !jsFiles.includes(f));
const extra = jsFiles.filter((f) => !JS_ORDER.includes(f));
if (missing.length > 0) {
  console.error(`Missing compiled files: ${missing.join(", ")}`);
  process.exit(1);
}
if (extra.length > 0) {
  console.error(`Unexpected compiled files (add them to JS_ORDER): ${extra.join(", ")}`);
  process.exit(1);
}

const banner = "/* Git Graph webview bundle - built from vendor/vscode-git-graph regenerate with\n"
  + "   node scripts/build-git-graph.mjs */\n";

const jsBody = JS_ORDER.map((file) => {
  const content = fs.readFileSync(path.join(compiledDir, file), "utf8").replace(/^"use strict";\r?\n/, "");
  return `/* ==== ${file} ==== */\n${content}`;
}).join("\n");
const js = `${banner}"use strict";\n(function (document, window) {\n${jsBody}\n})(document, window);\n`;

const cssBody = CSS_ORDER.map((file) => {
  const content = fs.readFileSync(path.join(stylesDir, file), "utf8");
  return `/* ==== ${file} ==== */\n${content}`;
}).join("\n");
const css = `${banner}${cssBody}`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "gitgraph.js"), js);
fs.writeFileSync(path.join(outDir, "gitgraph.css"), css);
console.log(`public/gitgraph/gitgraph.js  ${(js.length / 1024).toFixed(0)} KB`);
console.log(`public/gitgraph/gitgraph.css ${(css.length / 1024).toFixed(0)} KB`);
