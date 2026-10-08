import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { readFile } from "node:fs/promises";

// React ships `act` only in its development build; force NODE_ENV before any
// React module loads so these tests work regardless of the environment's
// default (production builds throw "act(...) is not supported").
process.env.NODE_ENV = "test";
const React = (await import("react")).default;
const { act, cleanup, fireEvent, render } = await import("@testing-library/react/pure.js");
const { renderToStaticMarkup } = await import("react-dom/server");
const { createJiti } = await import("jiti");

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const messageViewSource = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");
const { MessageView, SafeMarkdownBody, isInterruptedMessage } = await jiti.import("./MessageView.tsx");
const { CodeBlock } = await jiti.import("./MermaidBlock.tsx");
const { AgentLinkContext } = await jiti.import("../lib/agent-links.ts");
const { buildSessionContext } = await jiti.import("../lib/session-reader.ts");
const { collectToolResults } = await jiti.import("../lib/passive-tool-context.ts");
const { planTurnSegments } = await jiti.import("../lib/chat-segments.ts");
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
  const html = (message) => renderToStaticMarkup(React.createElement(MessageView, { message, toolResults, toolCallsDefaultCollapsed: false }));
  // Expanded tool group, collapsed cards: one truncating row on the last card, the full text on hover.
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
  // A harness wrapper (omp's rule reminders) becomes a label instead of raw tag text.
  const wrapped = new Map(toolResults);
  wrapped.set("call-2", { ...toolResults.get("call-2"), passiveContext: '<system-reminder reason="rule_violation" rule="ts-set-map">\nUse a Record.\n</system-reminder>' });
  const labeled = renderToStaticMarkup(React.createElement(MessageView, { message: single, toolResults: wrapped }));
  assert.match(labeled, /↳ <\/span>Context \(rule_violation · ts-set-map\): Use a Record\.<\/div>/);
  assert.doesNotMatch(labeled, /system-reminder/);
  // The length cap can cut the closing tag; the opening tag still never leaks.
  wrapped.set("call-2", { ...toolResults.get("call-2"), passiveContext: '<system-reminder reason="" rule="ts-set-map">\nUse a Rec' });
  const cut = renderToStaticMarkup(React.createElement(MessageView, { message: single, toolResults: wrapped }));
  assert.match(cut, /↳ <\/span>Context \(ts-set-map\): Use a Rec<\/div>/);
  assert.doesNotMatch(cut, /system-reminder/);
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
  const view = render(React.createElement(MessageView, {
    message: { role: "assistant", model: "test", provider: "test", content: [{ type: "text", text: "Done." }] },
    entryId: "assistant-1",
    // Resolved by resolveForkTargets: the newest reply falls back to its own
    // turn's prompt with edit-and-resend.
    forkEntryId: "user-1",
    forkEditsPrompt: true,
    onFork: (entryId, editPrompt) => forked.push([entryId, editPrompt]),
  }));
  assert.ok(view.getByRole("button", { name: "Copy message" }));
  await act(async () => { fireEvent.click(view.getByRole("button", { name: FORK_LABEL })); });
  assert.deepEqual(forked, [["user-1", true]]);
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
  assert.deepEqual(forked, [["user-7", true]]);
  view.unmount();
});