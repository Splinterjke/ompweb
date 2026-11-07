import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
const { act, cleanup, fireEvent, render } = await import("@testing-library/react/pure.js");
import { renderToStaticMarkup } from "react-dom/server";

const messageViewSource = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");
const { MessageView, SafeMarkdownBody, isInterruptedMessage } = await import("./MessageView.tsx");
const { CodeBlock } = await import("./MermaidBlock.tsx");
const { AgentLinkContext } = await import("../lib/agent-links.ts");
const { buildSessionContext } = await import("../lib/session-reader.ts");
const { collectToolResults } = await import("../lib/passive-tool-context.ts");
const { planTurnSegments } = await import("../lib/chat-segments.ts");
afterEach(cleanup);

test("large message content avoids the markdown pipeline until requested", () => {
  const largeMessage = "x".repeat(100_001);
  const html = renderToStaticMarkup(React.createElement(SafeMarkdownBody, null, largeMessage));

  assert.match(html, /Large message \(100 KB\)/);
  assert.doesNotMatch(html, /markdown-body/);
});

test("streaming code blocks avoid syntax-highlighter line markup", () => {
  const html = renderToStaticMarkup(React.createElement(CodeBlock, {
    code: "const value = 1;",
    lang: "ts",
    isStreaming: true,
  }));

  assert.match(html, /const value = 1;/);
  assert.doesNotMatch(html, /linenumber/);
});

test("MCP mount notices stay out of the transcript", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "xdev-mount-notice",
      content: "The xd:// device inventory changed.",
      display: false,
    },
  }));

  assert.equal(html, "");
});

test("streaming tool calls start collapsed when the interface preference is enabled", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: true,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "foo.ts" } }],
    },
  }));

  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /<pre/);
});

test("expanded tool calls show the compact command header", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "foo.ts" } }],
    },
  }));

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /tool-call-details/);
  assert.match(html, /\$<\/span><code>read foo\.ts<\/code>/);
});

// "Keep tool calls collapsed" off means nothing stays folded: a finished row
// is as open as the running one (it used to expand only while it executed).
test("a finished tool call expands as well when the preference keeps nothing collapsed", () => {
  const message = {
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "foo.ts" } }],
  };
  const toolResults = new Map([[
    "call-1",
    { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "the file" }] },
  ]]);

  const open = renderToStaticMarkup(React.createElement(MessageView, {
    message, toolResults, toolCallsDefaultCollapsed: false,
  }));
  assert.match(open, /aria-expanded="true"/, "the committed row stays open");
  assert.match(open, /the file/, "and its result is in the markup, not a collapsed header");

  const closed = renderToStaticMarkup(React.createElement(MessageView, {
    message, toolResults, toolCallsDefaultCollapsed: true,
  }));
  assert.match(closed, /aria-expanded="false"/, "the preference on keeps finished rows folded");
});

// "Show full tool input" (off by default) decides whether the row's arguments
// are rendered at rest, instead of asking for a "Show full input" press.
test("the full-input preference renders the arguments without a press", () => {
  const message = {
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "foo.ts" } }],
  };

  const expanded = renderToStaticMarkup(React.createElement(MessageView, {
    message, toolCallsDefaultCollapsed: false, toolInputExpanded: true,
  }));
  assert.match(expanded, /<dt>path<\/dt><dd><pre>foo\.ts<\/pre><\/dd>/);
  assert.match(expanded, /Collapse input/);

  const folded = renderToStaticMarkup(React.createElement(MessageView, {
    message, toolCallsDefaultCollapsed: false,
  }));
  assert.doesNotMatch(folded, /<dt>path<\/dt>/, "off by default: the arguments wait for the press");
  assert.match(folded, /Show full input/);
});

test("tool-row file links keep Windows drive paths and colon filenames intact", () => {
  const cases = [
    // Drive-letter colon is not a line suffix: splitting on ":" opened "C".
    ["C:\\Users\\me\\proj\\src\\file.ts", "C:\\Users\\me\\proj\\src\\file.ts"],
    ["C:/Users/me/proj/src/file.ts:42", "C:/Users/me/proj/src/file.ts"],
    ["src/my:file.txt", "src/my:file.txt"],
  ];
  for (const [path, expected] of cases) {
    const openedFiles = [];
    const { container } = render(React.createElement(MessageView, {
      onOpenFile(file) { openedFiles.push(file); },
      message: {
        role: "assistant",
        content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path } }],
      },
    }));
    // File links render as a clickable span (role="button"), unlike web URLs.
    fireEvent.click(container.querySelector(".activity-file-link"));
    assert.deepEqual(openedFiles, [expected], path);
    cleanup();
  }
});
test("expanded read output uses compact terminal text without line gutters", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "foo.ts" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "1: const value = 1;\\n2: return value;" }] },
    ]]),
  }));

  assert.match(html, /data-tool-output="true"/);
  assert.match(html, /const value = 1;/);
  assert.doesNotMatch(html, /1: const value/);
});

test("tool operations render as compact timeline rows", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      timestamp: 1000,
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "npm test" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", content: [], timestamp: 3000 },
    ]]),
  }));

  assert.match(html, /data-activity-operation="true"/);
  assert.match(html, /activity-row-indicator/);
  assert.match(html, /activity-row-duration/);
  assert.doesNotMatch(html, /border-radius:7px/);
});

test("parallel tool calls each render as their own row, never a merged group", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    toolCallsDefaultCollapsed: true,
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "a.ts" } },
        { type: "toolCall", toolCallId: "call-2", toolName: "read", input: { path: "b.ts" } },
        { type: "toolCall", toolCallId: "call-3", toolName: "grep", input: { pattern: "test" } },
      ],
    },
  }));

  assert.equal(html.match(/class="activity-row-trigger"/g)?.length, 3);
  for (const target of ["a.ts", "b.ts", "test"]) assert.match(html, new RegExp(target));
});

test("ask tool calls show the question text, not [object Object]", () => {
  // Malformed (header present, question missing) — falls back to the header.
  const malformed = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{
        type: "toolCall",
        toolCallId: "call-ask",
        toolName: "ask",
        input: {
          questions: [
            { header: "Resume engine", id: "resume-engine", options: [{ description: "a" }] },
            { header: "Prompt", id: "prompt", options: [{ description: "b" }] },
          ],
        },
      }],
    },
  }));
  assert.doesNotMatch(malformed, /\[object Object\]/);
  assert.match(malformed, /Resume engine/);
  assert.match(malformed, /Prompt/);

  // Valid (question present) — shows the question text.
  const valid = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{
        type: "toolCall",
        toolCallId: "call-ask",
        toolName: "ask",
        input: {
          questions: [
            { id: "q1", question: "Which resume engine should I use?", options: [] },
          ],
        },
      }],
    },
  }));
  assert.doesNotMatch(valid, /\[object Object\]/);
  assert.match(valid, /Which resume engine should I use\?/);
});

test("committed assistant messages offer copy actions before the fork button", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      timestamp: 1000,
      content: [{ type: "text", text: "Hello world" }],
    },
    forkEntryId: "entry-user",
    onFork: () => {},
  }));

  // Text blocks are wrapped for extraction; copy actions render next to the
  // fork button, ordered before it.
  assert.match(html, /data-message-text/);
  assert.match(html, /message-copy-actions/);
  assert.match(html, /Fork/);
  assert.ok(
    html.indexOf("message-copy-actions") < html.indexOf("Fork"),
    "copy actions must appear before the Fork button"
  );
});

test("streaming assistant messages do not show copy actions", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      timestamp: 1000,
      content: [{ type: "text", text: "Hello world" }],
    },
    isStreaming: true,
  }));

  assert.doesNotMatch(html, /message-copy-actions/);
});
test("copy actions anchor under the reply even when a stray text block follows a tool call", () => {
  // Mirrors a real committed entry: reply text, a tool call, then a
  // whitespace-only text block (omp commits a stray "\n" between tool calls)
  // followed by a second tool call. The stray block must not claim the
  // action-row anchor — the buttons belong under the reply text, above the
  // tool calls.
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      timestamp: 1000,
      content: [
        { type: "text", text: "The edit hit wrong lines — rewriting the file cleanly." },
        { type: "toolCall", toolCallId: "call-1", toolName: "write", input: { path: "a.test.mjs", content: "x" } },
        { type: "text", text: "\n" },
        { type: "toolCall", toolCallId: "call-2", toolName: "edit", input: { i: "update test", input: "edit body" } },
      ],
    },
  }));

  assert.match(html, /message-copy-actions/);
  assert.ok(
    html.indexOf("message-copy-actions") < html.indexOf('data-activity-operation="true"'),
    "copy actions must render directly under the reply text, before the tool calls"
  );
});
test("irc:incoming custom messages title with the sender name", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "irc:incoming",
      content: "<irc>\nIncoming IRC message from agent `AuditUiComponents`:\n\nPlease review the current tree.\nThanks.",
      display: true,
    },
  }));
  assert.match(html, /AuditUiComponents/);
  assert.doesNotMatch(html, /irc:incoming/);
  assert.match(html, /Please review the current tree/);
  assert.doesNotMatch(html, /Incoming IRC message from agent/);
});

test("advisor custom messages use the localized advisor label", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: { role: "custom", customType: "advisor", content: "Consider handling the edge case.", display: true },
  }));
  assert.match(html, /Advisor/);
  assert.match(html, /Consider handling the edge case/);
  assert.doesNotMatch(html, /customType/);
});


test("a running tool call shows a spinner instead of the no-result marker", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "long-job" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [], partial: true },
    ]]),
  }));

  assert.match(html, /activity-row-spinner/);
  assert.doesNotMatch(html, /lucide-check/);
  assert.doesNotMatch(html, /lucide-circle-slash/);
});

test("a running tool with no output yet says so instead of reporting no output", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "long-job" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [], partial: true },
    ]]),
  }));

  assert.match(html, /data-tool-running="true"/);
  assert.doesNotMatch(html, /no output/i);
});

test("a running tool streams its output before the result is committed", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "long-job" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "line-1\nline-2" }], partial: true },
    ]]),
  }));

  assert.match(html, /data-tool-output="true"/);
  assert.match(html, /line-1/);
  assert.match(html, /line-2/);
  assert.doesNotMatch(html, /data-tool-running="true"/);
});

test("a committed tool result replaces the running affordances", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "long-job" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "done" }], timestamp: 3000 },
    ]]),
  }));

  assert.doesNotMatch(html, /activity-row-spinner/);
  assert.doesNotMatch(html, /data-tool-running="true"/);
  assert.match(html, /lucide-check/);
});


test("skill-file reads stay collapsed even when tool calls default expanded", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: ".agents/skills/60fps-animation/SKILL.md" } },
        { type: "toolCall", toolCallId: "call-2", toolName: "read", input: { path: "src/plain.ts" } },
      ],
    },
  }));

  // 两个 toolCall 块：第一个 aria-expanded=false（skill 强制收起），
  // 第二个 =true（全局展开设置对普通文件生效）。仅统计主折叠触发器
  // （activity-row-trigger），排除工具输入展开按钮（tool-call-input-toggle）。
  const expandedFlags = [...html.matchAll(/<button[^>]*aria-expanded="(true|false)"[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => !tag.includes("tool-call-input-toggle"))
    .map((tag) => /aria-expanded="(true|false)"/.exec(tag)[1]);
  assert.equal(expandedFlags[0], "false");
  assert.equal(expandedFlags[1], "true");
});

test("skill content returned by a generic grep/read call stays collapsed", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-skill-result", toolName: "grep", input: { query: "SKILL.md", path: "/tmp" } }],
    },
    toolResults: new Map([[
      "call-skill-result",
      { role: "toolResult", toolCallId: "call-skill-result", content: [{ type: "text", text: "# .agents/skills/\n## 60fps-animation/\n### SKILL.md" }] },
    ]]),
  }));

  assert.match(html, /aria-expanded="false"/);
});

test("passive tool context from a session file renders on the batch's last tool card", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: at, message });
  const { messages } = buildSessionContext([
    entry("u1", null, { role: "user", content: "look around" }),
    entry("a1", "u1", {
      role: "assistant", provider: "t", model: "m",
      content: [
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "ls" } },
      ],
    }),
    entry("r1", "a1", { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "a" }] }),
    entry("r2", "r1", { role: "toolResult", toolCallId: "call-2", toolName: "bash", content: [{ type: "text", text: "b" }] }),
    entry("d1", "r2", {
      role: "developer", attribution: "agent", passiveToolContext: true, timestamp: 1,
      content: [{ type: "text", text: "\x1b[2mTreat\tthis result\nas authoritative.\x1b[0m" }],
    }),
    entry("d2", "d1", { role: "developer", content: [{ type: "text", text: "Unmarked steering note." }], timestamp: 2 }),
    entry("a2", "d2", { role: "assistant", provider: "t", model: "m", content: [{ type: "text", text: "Done." }] }),
  ]);
  const toolResults = collectToolResults(messages);
  const html = (message) => renderToStaticMarkup(React.createElement(MessageView, { message, toolResults, toolCallsDefaultCollapsed: true }));
  // Collapsed cards (the preference's default): one truncating row on the last
  // card, the full text on hover.
  const shown = html(messages[1]);
  assert.equal(shown.match(/>Context:/g)?.length, 1);
  assert.match(shown, /class="activity-row-secondary" title="Context: Treat\tthis result\nas authoritative\."><span aria-hidden="true">↳ <\/span>Context: Treat\tthis result\nas authoritative\./);
  assert.ok(shown.indexOf(">read<") < shown.indexOf(">bash<"));
  assert.ok(shown.indexOf("Context:") > shown.indexOf(">bash<"), "the line sits on the last card (call-2)");
  assert.doesNotMatch(shown, /tool-call-context/);
  // An expanded card shows the full text as its own segment at the end of its details instead.
  const single = { ...messages[1], content: [messages[1].content[1]] };
  const view = render(React.createElement(MessageView, { message: single, toolResults }));
  // Local adaptation: the details wrapper stays in the DOM while collapsed (upstream
  // mounts it on expand), so an `expanded: false` role query finds the input-toggle
  // too; click the row trigger directly.
  fireEvent.click(view.container.querySelector("button.activity-row-trigger"));
  const segment = view.container.querySelector(".tool-call-details .tool-call-context");
  assert.equal(segment?.textContent, "↳ Context: Treat\tthis result\nas authoritative.");
  assert.equal(view.container.querySelector(".activity-row-secondary[title]"), null, "no truncated row while expanded");
  // A harness wrapper shows as a label, titled like a developer message, never as raw tag text.
  const wrapped = new Map(toolResults);
  wrapped.set("call-2", { ...toolResults.get("call-2"), passiveContext: '<system-reminder reason="rule_violation" rule="ts-set-map">\nUse a Record.\n</system-reminder>' });
  const labeled = renderToStaticMarkup(React.createElement(MessageView, { message: single, toolResults: wrapped }));
  assert.match(labeled, /↳ <\/span>Context \(system-reminder · reason=rule_violation · rule=ts-set-map\): Use a Record\.<\/div>/);
  assert.doesNotMatch(labeled, /&lt;/);
  // The length cap can cut the closing tag; the opening tag still never leaks, and empty values drop out.
  wrapped.set("call-2", { ...toolResults.get("call-2"), passiveContext: '<system-reminder reason="" rule="ts-set-map">\nUse a Rec' });
  const cut = renderToStaticMarkup(React.createElement(MessageView, { message: single, toolResults: wrapped }));
  assert.match(cut, /↳ <\/span>Context \(system-reminder · rule=ts-set-map\): Use a Rec<\/div>/);
  assert.doesNotMatch(cut, /&lt;|reason=/);
  // Expanded, the wrapper becomes a nested card: its title as the header, the body below.
  wrapped.set("call-2", { ...toolResults.get("call-2"), passiveContext: '<system-reminder source="graphify">\nMANDATORY: run `graphify query`.\n</system-reminder>' });
  const card = render(React.createElement(MessageView, { message: single, toolResults: wrapped }));
  // Local adaptation: the details wrapper stays in the DOM while collapsed, so click the row trigger directly.
  fireEvent.click(card.container.querySelector("button.activity-row-trigger"));
  const nested = card.container.querySelector(".tool-call-details .tool-call-context-card");
  assert.equal(nested?.querySelector(".tool-call-context-title")?.textContent, "↳ system-reminder · source=graphify");
  assert.equal(nested?.querySelector(".tool-call-context-body")?.textContent, "MANDATORY: run `graphify query`.");
  // The marked message is no row of its own; the unmarked one still is.
  assert.equal(messages[4].customType, "passive-tool-context");
  assert.equal(html(messages[4]), "");
  assert.equal(messages[5].customType, "developer");
  assert.equal(messages[5].display, true);
  assert.match(html(messages[5]), /Unmarked steering note\./);
  assert.deepEqual(
    planTurnSegments(messages, 0, messages.length).map((segment) => segment.kind === "text" ? "text" : segment.pieces.map((piece) => piece.index)),
    [[1, 5], "text"],
  );
});

test("deferred thinking rows prefetch their body instead of relying on click-time fetch", () => {
  // The behavior is intentionally implemented as a mount prefetch so the
  // collapsed row never has to expose an empty shell after a user opens it.
  assert.match(messageViewSource, /Prefetch once when the row mounts/);
});

test("streaming thinking auto-expands only while it is the latest block", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "first attempt reasoning" },
        { type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "a.ts" } },
        { type: "thinking", thinking: "second attempt reasoning" },
      ],
    },
  }));

  // 仅统计主折叠触发器（activity-row-trigger），排除工具输入展开按钮
  // （tool-call-input-toggle）——后者默认收起，会多出一个 false。
  const expandedFlags = [...html.matchAll(/<button[^>]*aria-expanded="(true|false)"[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => !tag.includes("tool-call-input-toggle"))
    .map((tag) => /aria-expanded="(true|false)"/.exec(tag)[1]);
  // 第一段思考（已过时）收起；toolCall 收起；最新一段思考展开。
  assert.equal(expandedFlags[0], "false");
  assert.equal(expandedFlags[2], "true");
});

test("committed thinking blocks default collapsed", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "finished reasoning" }],
    },
  }));

  assert.match(html, /aria-expanded="false"/);
});

test("the model label hides on activity-only rows but stays on a row that also carries reply text", () => {
  const html = (content) => renderToStaticMarkup(React.createElement(MessageView, {
    message: { role: "assistant", provider: "t", model: "label-model", content },
    modelNames: { "t:label-model": "Label Model" },
  }));
  const labelShown = (markup) => /display:flex[^>]*><span>Label Model<\/span>/.test(markup);
  assert.equal(labelShown(html([{ type: "thinking", thinking: "plan" }])), false);
  // Unfolded thinking rides in the reply's segment; the reply keeps its attribution.
  assert.equal(labelShown(html([{ type: "thinking", thinking: "plan" }, { type: "text", text: "Answer" }])), true);
  assert.equal(labelShown(html([{ type: "text", text: "Answer" }])), true);
});

test("provider errors render as a persistent assistant error row", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      content: [],
      provider: "opencodex",
      model: "pro/gpt-5.6",
      stopReason: "error",
      errorStatus: 403,
      errorMessage: "预扣费失败，用户剩余额度不足",
    },
  }));

  assert.match(html, /data-message-error="true"/);
  assert.match(html, /Error: 403/);
  assert.match(html, /预扣费失败/);
});

test("isInterruptedMessage identifies user interruptions accurately", () => {
  assert.equal(isInterruptedMessage("Interrupted by user"), true);
  assert.equal(isInterruptedMessage("interrupted by user"), true);
  assert.equal(isInterruptedMessage("Interrupted"), true);
  assert.equal(isInterruptedMessage("Request aborted"), true);
  assert.equal(isInterruptedMessage("Aborted"), true);
  assert.equal(isInterruptedMessage(null, "aborted"), true);
  assert.equal(isInterruptedMessage("Generation stopped by user"), true);
  assert.equal(isInterruptedMessage("429 Too Many Requests"), false);
  assert.equal(isInterruptedMessage("Provider connection failed"), false);
  assert.equal(isInterruptedMessage(null), false);
});

test("interrupted assistant message renders a status badge, not an error alert", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      content: [],
      provider: "omp",
      model: "x",
      stopReason: "aborted",
    },
  }));

  assert.match(html, /role="status"/);
  assert.match(html, /data-message-interrupted="true"/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.doesNotMatch(html, /Error: /);
});

test("actual error assistant message keeps the alert row", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      content: [],
      provider: "omp",
      model: "x",
      stopReason: "error",
      errorStatus: 429,
      errorMessage: "429 Too Many Requests: Rate limit exceeded",
    },
  }));

  assert.match(html, /role="alert"/);
  assert.match(html, /data-message-error="true"/);
  assert.match(html, /429 Too Many Requests/);
  assert.doesNotMatch(html, /data-message-interrupted="true"/);
});

test("interrupted message with partial content renders content before the badge", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Partial generated response text" }],
      provider: "omp",
      model: "x",
      stopReason: "aborted",
      errorMessage: "Interrupted by user",
    },
  }));

  const contentIdx = html.indexOf("Partial generated response text");
  const badgeIdx = html.indexOf("data-message-interrupted");
  assert.ok(contentIdx !== -1, "partial content must be rendered");
  assert.ok(badgeIdx !== -1, "badge must be rendered");
  assert.ok(contentIdx < badgeIdx, "content must precede the interrupted badge");

});

test("a settled tool call with no committed result shows the done marker, not a spinner", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "long-job" } }],
    },
    toolResults: new Map(),
    settled: true,
  }));
  assert.match(html, /lucide-check/);
  assert.doesNotMatch(html, /activity-row-spinner/);
  assert.doesNotMatch(html, /lucide-loader-circle/);
});

test("an in-flight tool call with no committed result keeps the spinner", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "long-job" } }],
    },
    toolResults: new Map(),
  }));
  assert.match(html, /activity-row-spinner/);
  assert.doesNotMatch(html, /lucide-check/);
});

test("async-result notices keep their exact line layout and drop the wrapper tag", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "async-result",
      content: "<system-notice>\nBackground job bg_1 has completed. Resume your work using the result below.\n/root/repo\n---\nWall time: 0.16 seconds\n</system-notice>",
      display: true,
    },
  }));
  assert.match(html, /<pre style="[^"]*white-space:pre;[^"]*">Background job bg_1 has completed\. Resume your work using the result below\.\n\/root\/repo\n---\nWall time: 0\.16 seconds<\/pre>/);
  assert.doesNotMatch(html, /word-break/);
  assert.doesNotMatch(html, /system-notice|<h2/);
});

test("late LSP diagnostic notices keep their exact line layout and drop the wrapper tag", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "lsp-late-diagnostic",
      content: "<system-notice>\nLate LSP diagnostics arrived after the edit returned:\n/repo/a.py — 0 error(s), 1 warning(s)\n/repo/a.py:8:1 [warning] [Ruff] Import block is un-sorted or un-formatted\n\nhelp: Organize imports (I001)\n</system-notice>",
      display: true,
    },
  }));
  assert.match(html, /<pre style="[^"]*white-space:pre;[^"]*">Late LSP diagnostics arrived after the edit returned:\n\/repo\/a\.py — 0 error\(s\), 1 warning\(s\)\n\/repo\/a\.py:8:1 \[warning\] \[Ruff\] Import block is un-sorted or un-formatted\n\nhelp: Organize imports \(I001\)<\/pre>/);
  assert.doesNotMatch(html, /system-notice/);
});

test("read paths with an internal URL scheme are not links", () => {
  const renderRow = (path) => renderToStaticMarkup(React.createElement(MessageView, {
    onOpenFile() {},
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path } }],
    },
  }));

  for (const path of ["history://ScoutAgent", "proc://Job1", "local://notes.md", "ftp://example.com/a.ts", "javascript://x%0Aalert(1)", "file:///etc/passwd"]) {
    assert.doesNotMatch(renderRow(path), /role="link"/, path);
  }
});

test("read paths with a web URL render a link to the fetched page without read selectors", () => {
  const renderRow = (path) => renderToStaticMarkup(React.createElement(MessageView, {
    onOpenFile() {},
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path } }],
    },
  }));

  const html = renderRow("https://example.com/docs:raw");
  assert.match(html, /role="link"/);
  assert.match(html, /title="https:\/\/example\.com\/docs"/);

  const html2 = renderRow("https://example.com:8080/a.md:10-20");
  assert.match(html2, /role="link"/);
  assert.match(html2, /title="https:\/\/example\.com:8080\/a\.md"/);
});

test("read of an agent:// handle renders a link when a chat provider is present", () => {
  const html = renderToStaticMarkup(React.createElement(AgentLinkContext.Provider, { value() {} },
    React.createElement(MessageView, {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "agent://Scout" } }],
      },
    })));
  assert.match(html, /role="link"/);
  assert.match(html, /agent:\/\/Scout/);
});

const FORK_LABEL = "Fork a new session from this point";

test("agent replies offer copy and fork at their resolved target", async (t) => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  t.after(() => {
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    else delete window.matchMedia;
  });
  const forked = [];
  const props = {
    message: { role: "assistant", model: "test", provider: "test", content: [{ type: "text", text: "Done." }] },
    entryId: "assistant-1",
    // Resolved by resolveForkTargets: the newest reply falls back to its own
    // turn's prompt with edit-and-resend.
    forkEntryId: "user-1",
    forkEditsPrompt: true,
    onFork: (entryId, editPrompt) => forked.push([entryId, editPrompt]),
  };
  const view = render(React.createElement(MessageView, props));
  assert.ok(view.getByRole("button", { name: "Copy message" }));
  await act(async () => { fireEvent.click(view.getByRole("button", { name: FORK_LABEL })); });
  assert.deepEqual(forked, [], "the fork button only asks for confirmation");
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Cancel" })); });
  assert.deepEqual(forked, []);
  await act(async () => { fireEvent.click(view.getByRole("button", { name: FORK_LABEL })); });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Fork" })); });
  assert.deepEqual(forked, [["user-1", true]]);

  await act(async () => { fireEvent.click(view.getByRole("button", { name: FORK_LABEL })); });
  view.rerender(React.createElement(MessageView, { ...props, forkDisabled: true }));
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Fork" })); });
  assert.deepEqual(forked, [["user-1", true]], "a row blocked while the dialog was open does not fork");
  view.unmount();
});

test("user messages fork at their own entry and edit the prompt", async (t) => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  t.after(() => {
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    else delete window.matchMedia;
  });
  const forked = [];
  const view = render(React.createElement(MessageView, {
    message: { role: "user", content: "Keep this forkable." },
    entryId: "user-7",
    forkEntryId: "user-7",
    onFork: (entryId, editPrompt) => forked.push([entryId, editPrompt]),
  }));
  await act(async () => { fireEvent.click(view.getByRole("button", { name: FORK_LABEL })); });
  assert.deepEqual(forked, []);
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Fork" })); });
  assert.deepEqual(forked, [["user-7", true]]);
  view.unmount();
});

test("async-result details render job metadata rows with a working transcript action", () => {
  const opened = [];
  const view = render(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "async-result",
      content: "<system-notice>Background job finished.</system-notice>",
      details: {
        jobs: [
          { jobId: "Worker-t1-2", type: "task", status: "failed", agentId: "Worker-t1", label: "audit pass", durationMs: 65_000 },
          { jobId: "plain-job", status: "completed" },
        ],
      },
    },
    onOpenSubagent: (agentId, fallback) => opened.push([agentId, fallback]),
  }));
  assert.match(view.container.textContent, /audit pass/);
  assert.match(view.container.textContent, /failed/);
  assert.match(view.container.textContent, /1m/);
  // The second job has no agentId: its row shows the jobId and no button.
  assert.match(view.container.textContent, /plain-job/);
  fireEvent.click(view.getByRole("button", { name: /Worker-t1/ }));
  assert.deepEqual(opened, [["Worker-t1", { label: "audit pass", status: "failed" }]]);
  view.unmount();
});

test("async-result messages without job details render no metadata rows", () => {
  const view = render(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "async-result",
      content: "<system-notice>Job output body.</system-notice>",
    },
  }));
  assert.match(view.container.textContent, /Job output body/);
  assert.doesNotMatch(view.container.textContent, /completed/);
  view.unmount();
});
test("user-message Edit only runs after confirmation, and not once blocked", async (t) => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  t.after(() => {
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    else delete window.matchMedia;
  });
  const edited = [];
  const props = {
    message: { role: "user", content: "Rewind to here." },
    entryId: "user-9",
    onEdit: async (entryId, content) => { edited.push([entryId, content]); return true; },
  };
  const view = render(React.createElement(MessageView, props));
  const editButton = view.getByRole("button", { name: "Jump back here and edit this message" });
  await act(async () => { fireEvent.click(editButton); });
  assert.deepEqual(edited, [], "the Edit button only asks for confirmation");
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Cancel" })); });
  assert.deepEqual(edited, []);
  await act(async () => { fireEvent.click(editButton); });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Edit" })); });
  assert.deepEqual(edited, [["user-9", "Rewind to here."]]);

  await act(async () => { fireEvent.click(editButton); });
  view.rerender(React.createElement(MessageView, { ...props, editDisabled: true }));
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Edit" })); });
  assert.deepEqual(edited, [["user-9", "Rewind to here."]], "a row blocked while the dialog was open does not edit");
  assert.equal(view.queryByRole("button", { name: "Edit" }), null, "confirming closes the dialog");
  view.unmount();
});

test("an open confirmation closes when the row starts showing another message", async (t) => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  t.after(() => {
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    else delete window.matchMedia;
  });
  const calls = [];
  const row = (entryId, content) => React.createElement(MessageView, {
    message: { role: "user", content },
    entryId,
    onEdit: async (id, text) => { calls.push(["edit", id, text]); return true; },
    onFork: (id) => calls.push(["fork", id]),
  });
  // ChatWindow keys rows by index, so a history swap reuses this component for another entry.
  const view = render(row("user-1", "Selected."));
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Jump back here and edit this message" })); });
  view.rerender(row("user-2", "Someone else."));
  assert.equal(view.queryByRole("button", { name: "Edit" }), null, "the Edit dialog closes");

  await act(async () => { fireEvent.click(view.getByRole("button", { name: FORK_LABEL })); });
  view.rerender(row("user-3", "Another one."));
  assert.equal(view.queryByRole("button", { name: "Fork" }), null, "the Fork dialog closes");

  view.rerender(row("user-1", "Selected."));
  assert.equal(view.queryByRole("button", { name: "Edit" }), null, "returning to the entry does not reopen its Edit dialog");
  view.rerender(row("user-2", "Someone else."));
  view.rerender(row("user-3", "Another one."));
  assert.equal(view.queryByRole("button", { name: "Fork" }), null, "returning to the entry does not reopen its Fork dialog");

  // Edit can drop out (onEdit withdrawn) while its dialog is open; it must not come back by itself.
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Jump back here and edit this message" })); });
  view.rerender(React.createElement(MessageView, { message: { role: "user", content: "Another one." }, entryId: "user-3" }));
  view.rerender(row("user-3", "Another one."));
  assert.equal(view.queryByRole("button", { name: "Edit" }), null, "Edit returning does not reopen its dialog");
  assert.deepEqual(calls, []);
  view.unmount();
});

test("a `!` run renders as a shell card with its command, status and output", () => {
  const shell = (message) => {
    const view = render(React.createElement(MessageView, { message: { role: "bashExecution", ...message } }));
    return { view, header: view.container.querySelector(".shell-run-header") };
  };

  const ok = shell({ command: "git status", output: "clean\n", exitCode: 0 });
  assert.equal(ok.header.querySelector(".shell-run-command").textContent, "git status");
  assert.equal(ok.view.container.querySelector(".shell-run-output"), null, "collapsed until opened");
  fireEvent.click(ok.header);
  assert.equal(ok.view.container.querySelector(".shell-run-output").textContent, "clean\n");
  assert.equal(ok.view.container.querySelector(".shell-run-failed"), null);
  assert.equal(ok.header.querySelector(".shell-run-tag"), null, "only `!!` runs are tagged local");
  fireEvent.click(ok.header);
  assert.equal(ok.view.container.querySelector(".shell-run-output"), null, "the header closes it again");
  cleanup();

  const failed = shell({ command: "false", output: "", exitCode: 1 });
  assert.match(failed.header.querySelector(".shell-run-status").textContent, /exit 1/);
  assert.ok(failed.view.container.querySelector(".shell-run-failed"));
  fireEvent.click(failed.header);
  assert.equal(failed.view.container.querySelector(".shell-run-output").textContent, "(no output)");
  cleanup();

  const cancelled = shell({ command: "sleep 9", output: "", cancelled: true });
  assert.match(cancelled.header.querySelector(".shell-run-status").textContent, /cancelled/);
  cleanup();

  const local = shell({ command: "env", output: "A=1", exitCode: 0, excludeFromContext: true });
  assert.equal(local.header.querySelector(".shell-run-tag").textContent, "local");
  cleanup();

  const pending = shell({ command: "make", output: "" });
  assert.ok(pending.header.querySelector(".activity-row-spinner"), "a running command shows a spinner");
  assert.equal(pending.header.getAttribute("aria-disabled"), "true", "the header cannot be toggled while it runs");
  fireEvent.click(pending.header);
  assert.equal(pending.header.getAttribute("aria-expanded"), "false");
  assert.equal(pending.view.container.querySelector(".shell-run-output"), null, "no empty output while it runs");
});

test("shell card expansion resets for a different run but survives output updates", () => {
  const message = { role: "bashExecution", command: "printf hello", output: "hello", exitCode: 0, timestamp: 10 };
  const view = render(React.createElement(MessageView, { message }));
  const header = () => view.container.querySelector(".shell-run-header");
  fireEvent.click(header());
  assert.equal(header().getAttribute("aria-expanded"), "true");
  view.rerender(React.createElement(MessageView, { message: { ...message, output: "hello\n" } }));
  assert.equal(header().getAttribute("aria-expanded"), "true", "refreshing the same run keeps the reader's expansion");
  view.rerender(React.createElement(MessageView, { message: { ...message, timestamp: 20 } }));
  assert.equal(header().getAttribute("aria-expanded"), "false", "a different run of the same command starts collapsed");
});

test("a branch switch that reuses the card for another untimed run of the same command starts it collapsed", () => {
  const message = { role: "bashExecution", command: "ls", output: "a", exitCode: 0 };
  const view = render(React.createElement(MessageView, { message, entryId: "e1" }));
  const header = () => view.container.querySelector(".shell-run-header");
  fireEvent.click(header());
  view.rerender(React.createElement(MessageView, { message: { ...message }, entryId: "e1" }));
  assert.equal(header().getAttribute("aria-expanded"), "true", "a reload of the same entry keeps it open");
  view.rerender(React.createElement(MessageView, { message: { ...message, output: "b" }, entryId: "e2" }));
  assert.equal(header().getAttribute("aria-expanded"), "false");
});

test("a successful shell card exposes its outcome in its accessible name", () => {
  const view = render(React.createElement(MessageView, {
    message: { role: "bashExecution", command: "true", output: "", exitCode: 0 },
  }));
  assert.ok(view.getByRole("button", { name: /true.*succeeded/i }));
});
