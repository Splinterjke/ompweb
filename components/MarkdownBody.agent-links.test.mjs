import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { AgentLinkContext, agentLinkIds, agentLinkTarget } = await jiti.import("../lib/agent-links.ts");

function renderWithAgentLinks(markdown) {
  return renderToStaticMarkup(
    React.createElement(AgentLinkContext.Provider, { value() {} },
      React.createElement(MarkdownBody, {
        cwd: "/home/me/project",
        onOpenFile() {},
      }, markdown)),
  );
}

test("links agent:// handles in prose, exact inline code, and markdown links", () => {
  const html = renderWithAgentLinks("Output at agent://Review.Child. See `agent://Scout` and [notes](agent://Notes/0).");

  assert.match(html, /<a href="agent:\/\/Review\.Child"[^>]*>agent:\/\/Review\.Child<\/a>\./);
  assert.match(html, /<a href="agent:\/\/Scout"[^>]*><code[^>]*>agent:\/\/Scout<\/code><\/a>/);
  assert.match(html, /<a href="agent:\/\/Notes\/0"[^>]*>notes<\/a>/);
  assert.doesNotMatch(html, /target="_blank"/);
});

test("leaves agent:// handles inside code and larger code spans unlinked", () => {
  const html = renderWithAgentLinks("`write agent://Scout`\n\n```\nagent://Scout\n```\n\nxagent://Scout");

  assert.doesNotMatch(html, /<a /);
});

test("renders agent:// handles as plain text outside a chat view", () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, "[out](agent://Scout) agent://Scout"));

  assert.doesNotMatch(html, /<a /);
  assert.match(html, /out agent:\/\/Scout/);
});

test("resolves agent:// hrefs to nested id before the base id", () => {
  assert.deepEqual(agentLinkIds("agent://Parent/Child"), ["Parent.Child", "Parent"]);
  assert.deepEqual(agentLinkIds("agent://Parent/items/0?x"), ["Parent.items.0", "Parent"]);
  assert.deepEqual(agentLinkIds("agent://Parent/a.b"), ["Parent"]);
  assert.deepEqual(agentLinkIds("agent://Parent?q=.x"), ["Parent"]);
  assert.deepEqual(agentLinkIds("https://example.com"), []);
});

test("opens the most specific roster entry, else a disk-backed stub for the base id", () => {
  const parent = { id: "Parent", agent: "task", status: "completed", index: 0 };
  const child = { id: "Parent.Child", agent: "scout", status: "started", index: 1 };

  assert.equal(agentLinkTarget(["Parent.Child", "Parent"], [parent, child]), child);
  assert.equal(agentLinkTarget(["Parent.Child", "Parent"], [parent]), parent);
  assert.deepEqual(agentLinkTarget(["Gone.Kid", "Gone"], [parent]), {
    id: "Gone", agent: "Gone", status: "completed", index: 0, source: "history",
  });
});

test("never links the agent://all broadcast address and drops non-handle agent: hrefs", () => {
  const html = renderWithAgentLinks("[a](agent:Foo) <a href=\"agent:Bar\">b</a> agent://all `agent://all` [c](agent://all) <a href=\"agent://all?q=.x\">d</a>");

  assert.doesNotMatch(html, /href=""/);
  assert.doesNotMatch(html, /href="agent:/);
});
