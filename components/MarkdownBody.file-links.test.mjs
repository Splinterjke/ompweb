import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

// React only ships `act` in its development build; force NODE_ENV before any
// React module is loaded so these tests work regardless of the environment's
// default (production builds throw "act(...) is not supported").
process.env.NODE_ENV = "test";
const React = (await import("react")).default;
const { cleanup, fireEvent, render } = await import("@testing-library/react/pure.js");
const { createJiti } = await import("jiti");

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");

afterEach(cleanup);

function renderChat(markdown, opened = []) {
  return render(React.createElement(MarkdownBody, { cwd: "/home/me/project", onOpenFile: (file) => opened.push(file) }, markdown));
}

// Assertions compare plain values: a failing assert that prints a jsdom node can exhaust memory.

test("an inline-code path opens the cleaned path in the file panel", () => {
  const opened = [];
  const { container } = renderChat(
    "Shot: `/var/tmp/omp-sshots-1.webp`, see `src/app.ts:12`, `~/notes/a.md`, `C:\\Users\\me\\b.txt:3:4`.",
    opened,
  );
  const links = [...container.querySelectorAll("a")];

  assert.deepEqual(links.map((a) => a.textContent), ["/var/tmp/omp-sshots-1.webp", "src/app.ts:12", "~/notes/a.md", "C:\\Users\\me\\b.txt:3:4"]);
  assert.ok(links.every((a) => a.firstElementChild?.tagName === "CODE" && !a.hasAttribute("target")));
  for (const link of links) assert.equal(fireEvent.click(link, { button: 0 }), false, "click default must be prevented");
  assert.deepEqual(opened, ["/var/tmp/omp-sshots-1.webp", "/home/me/project/src/app.ts", "~/notes/a.md", "C:/Users/me/b.txt"]);
});

// Local drift vs upstream: the fork's remarkPathLinks (in the shared plugin set)
// also linkifies some inline-code paths — ones this plugin deliberately rejects
// (`/compact` is single-segment, `../outside.ts` and `/api/files/a.ts` resolve
// to nothing openable). Upstream asserts "no anchors at all"; here the inline-
// code plugin's own contribution must be zero, i.e. no anchor wraps its code,
// and clicking nothing was registered.
test("ordinary code, scheme handles, fenced blocks and escaping paths get no inline-code link", () => {
  const opened = [];
  const { container } = renderChat(
    [
      "`foo.bar()` `foo.bar` `a/b` `x => y` `/compact` `rm -rf /tmp/x` `../outside.ts` `/api/files/a.ts`",
      "`history://abc` `proc://1` `local://plan.md` `https://x.test/a.png` `file:///tmp/a.png`",
      "```\n/var/tmp/a.png\n```",
    ].join("\n\n"),
    opened,
  );

  assert.equal(container.querySelectorAll("a code").length, 0);
  assert.deepEqual(opened, []);
});

test("inline-code paths stay code outside a file-opening view and inside existing links", () => {
  const plain = render(React.createElement(MarkdownBody, null, "`/var/tmp/a.png`"));
  assert.equal(plain.container.querySelectorAll("a code").length, 0);
  cleanup();

  const { container } = renderChat("[`/var/tmp/a.png`](https://x.test)");
  const links = container.querySelectorAll("a");
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute("href"), "https://x.test");
});
