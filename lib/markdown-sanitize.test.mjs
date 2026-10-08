import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { useMarkdownPlugins } = await jiti.import("./markdown.ts");
const ReactMarkdown = (await jiti.import("react-markdown")).default;

// Renders through the production rehype pipeline (rehypeRaw + the sanitize
// schema) with the URL transform neutralized, so every href below faces the
// sanitizer itself — the last line of defense for MarkdownBody, whose own
// transform deliberately keeps unknown-but-local shapes like drive letters.
function SanitizerProbe({ markdown }) {
  const { remarkPlugins, rehypePlugins } = useMarkdownPlugins(markdown);
  return React.createElement(ReactMarkdown, {
    remarkPlugins,
    rehypePlugins,
    urlTransform: (url) => url,
  }, markdown);
}

function render(markdown) {
  return renderToStaticMarkup(React.createElement(SanitizerProbe, { markdown }));
}

test("the sanitizer keeps rejecting scheme-shaped and script hrefs", () => {
  const html = render([
    "[a](javascript:alert(1))",
    "[b](data:text/html;base64,PHN2Zy8+)",
    "[c](vbscript:msgbox)",
    "[d](javascript.file:x)",
    "[e](anything:something)",
    "[f](java.script%3Aalert(1))",
  ].join(" "));

  // Assertions compare plain values: no anchor below may keep an href.
  assert.equal(html.match(/href=/g), null, html);
});

test("the sanitizer admits local path shapes the file panel can open", () => {
  const html = render([
    "[a](~/shots/a.png)",
    "[b](<C%3A\\Users\\me\\b.txt%3A3%3A4>)",
    "[c](other.md)",
    "[d](b.txt%3A3)",
    "[e](src/app.ts)",
    "[f](/abs/a.ts)",
    "[g](#frag)",
    "[h](https://x.test/a.png)",
  ].join(" "));

  for (const href of [
    "~/shots/a.png",
    "other.md",
    "b.txt%3A3",
    // to-hast encodes the backslashes (%5C); the resolver decodes them back.
    "C%3A%5CUsers%5Cme%5Cb.txt%3A3%3A4",
    "/abs/a.ts",
    "#frag",
    "https://x.test/a.png",
  ]) {
    assert.ok(html.includes(`href="${href}"`), `missing href ${href} in ${html}`);
  }
});
