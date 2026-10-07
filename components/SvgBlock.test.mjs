import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SvgBlock, svgRootMarkup } = await jiti.import("./SvgBlock.tsx");

const svgSrc = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>`;

test("svgRootMarkup requires an <svg> root, tolerating prologue and comments", () => {
  assert.ok(svgRootMarkup(svgSrc));
  assert.ok(svgRootMarkup(`<?xml version="1.0"?>\n<!-- note -->\n${svgSrc}\n`));
  assert.equal(svgRootMarkup("<html></html>"), null);
  assert.equal(svgRootMarkup("<svgrect/>"), null);
  assert.equal(svgRootMarkup(""), null);
});

test("SvgBlock renders source by default", () => {
  const html = renderToStaticMarkup(
    React.createElement(SvgBlock, { code: svgSrc }),
  );

  // en.json is assembled from locale parts; before assembly the key renders as-is.
  assert.match(html, />(Preview|svgBlock\.preview)</);
  assert.doesNotMatch(html, /data:image\/svg\+xml/);
});

test("SvgBlock preview renders the markup as an inert data-URI image", () => {
  const html = renderToStaticMarkup(
    React.createElement(SvgBlock, { code: svgSrc, defaultPreview: true }),
  );

  const expected = Buffer.from(svgSrc, "utf8").toString("base64");
  assert.ok(html.includes(`src="data:image/svg+xml;base64,${expected}"`), `missing data URI in ${html}`);
  assert.match(html, /<img/);
  assert.doesNotMatch(html, /<svg xmlns/);
});

test("SvgBlock preview survives a UTF-8 payload", () => {
  const code = `<svg xmlns="http://www.w3.org/2000/svg"><text>日本語</text></svg>`;
  const html = renderToStaticMarkup(
    React.createElement(SvgBlock, { code, defaultPreview: true }),
  );
  const expected = Buffer.from(code, "utf8").toString("base64");
  assert.ok(html.includes(`src="data:image/svg+xml;base64,${expected}"`), `missing data URI in ${html}`);
});

test("SvgBlock with isStreaming falls back to source view", () => {
  const html = renderToStaticMarkup(
    React.createElement(SvgBlock, { code: svgSrc, isStreaming: true, defaultPreview: true }),
  );
  assert.match(html, /disabled/);
  assert.doesNotMatch(html, /data:image\/svg\+xml/);
});

test("SvgBlock without an svg root shows the invalid marker", () => {
  const html = renderToStaticMarkup(
    React.createElement(SvgBlock, { code: "not svg at all", defaultPreview: true }),
  );
  assert.match(html, /svgBlock\.invalidSvg|Invalid SVG image/);
  assert.doesNotMatch(html, /data:image\/svg\+xml/);
});
