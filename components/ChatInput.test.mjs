import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatInput, ModelErrorBanner, filterModelOptions } = await jiti.import("./ChatInput.tsx");
const { setDraft, clearDraft } = await jiti.import("@/lib/draft-store");

test("keeps Stop as the primary action while streaming, even with typed text", () => {
  const draftKey = "chat-input-queue-action-test";
  setDraft(draftKey, { value: "Continue after the current run", images: [], files: [] });
  try {
    const html = renderToStaticMarkup(
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onFollowUp() {},
        isStreaming: true,
        draftKey,
      }),
    );

    // Stop must stay reachable during a run; queued follow-ups are sent via
    // Enter / the queued-follow-up bar instead of replacing the Stop button.
    assert.match(html, />(Stop|chatInput\.stop)</);
    assert.doesNotMatch(html, />(Queue|chatInput\.queue)</);
  } finally {
    clearDraft(draftKey);
  }
});

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelErrorBanner, {
      error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
    }),
  );

  assert.match(html, /role="alert"/);
  // en.json is assembled from locale parts; before assembly the key renders as-is.
  assert.match(html, /(Model error|chatInput\.modelError)/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ModelErrorBanner, { error: null })), "");
});

test("formats structured Claude low-priority state in the browser locale", () => {
  const resetsAtSec = Math.floor(Date.now() / 1000) + 3_600;
  const time = new Date(resetsAtSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
      anthropicSlowMode: { stage: "low_priority", resetsAtSec, allowanceLeftPercent: 62 },
    }),
  );
  assert.match(html, new RegExp(`low priority until ${time.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · 62% left`));
});

test("formats every Claude usage-limit stage", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const shortReset = nowSec + 3_600;
  const longReset = nowSec + 86_400;
  const shortTime = new Date(shortReset * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const longTime = new Date(longReset * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const rows = [
    [{ stage: "low_priority", resetsAtSec: shortReset }, `low priority until ${shortTime}`],
    [{ stage: "wrap_up", extraUsage: false }, "limit reached · wrapping up"],
    [{ stage: "wrap_up", resetsAtSec: shortReset, extraUsage: false }, `limit reached · wrapping up · resets ${shortTime}`],
    [{ stage: "wrap_up", extraUsage: true }, "limit reached · wrap-up, then extra usage"],
    [{ stage: "low_priority", resetsAtSec: longReset }, `low priority until ${longTime}`],
  ];
  for (const [anthropicSlowMode, label] of rows) {
    const html = renderToStaticMarkup(
      React.createElement(ChatInput, { onSend() {}, onAbort() {}, isStreaming: false, anthropicSlowMode }),
    );
    assert.ok(html.includes(label), `${JSON.stringify(anthropicSlowMode)} should render ${label}`);
  }
});

test("never renders a null percentage, an invalid date, or a past reset clock", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const pastSec = nowSec - 3_600;
  const rows = [
    { stage: "low_priority", resetsAtSec: nowSec + 3_600, allowanceLeftPercent: null },
    { stage: "low_priority", resetsAtSec: nowSec + 3_600, allowanceLeftPercent: Number.NaN },
    { stage: "low_priority", resetsAtSec: null, allowanceLeftPercent: 62 },
    { stage: "low_priority", resetsAtSec: undefined, allowanceLeftPercent: 62 },
    { stage: "low_priority", resetsAtSec: null },
    { stage: "low_priority", resetsAtSec: pastSec, allowanceLeftPercent: 62 },
    { stage: "wrap_up", resetsAtSec: null, extraUsage: false },
    { stage: "wrap_up", resetsAtSec: pastSec, extraUsage: false },
  ];
  for (const anthropicSlowMode of rows) {
    const html = renderToStaticMarkup(
      React.createElement(ChatInput, { onSend() {}, onAbort() {}, isStreaming: false, anthropicSlowMode }),
    );
    const label = `${JSON.stringify(anthropicSlowMode)} -> ${html}`;
    // "null" / "NaN" / "Invalid Date" reaching the label is the bug this pins:
    // every one of them is a value the user would plan their session around.
    assert.ok(!html.includes("Invalid Date"), `invalid date rendered: ${label}`);
    assert.ok(!html.includes("null%"), `null percentage rendered: ${label}`);
    assert.ok(!html.includes("NaN%"), `NaN percentage rendered: ${label}`);
    // A reset already in the past must not render a plausible wrong clock.
    if (anthropicSlowMode.resetsAtSec === pastSec) {
      assert.ok(!html.includes(new Date(pastSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
        `past reset clock rendered: ${label}`);
    }
  }
  // The allowance is still worth showing when the reset time is unusable.
  assert.match(
    renderToStaticMarkup(
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
        anthropicSlowMode: { stage: "low_priority", resetsAtSec: null, allowanceLeftPercent: 62 },
      }),
    ),
    /low priority · 62% left/,
  );
  // ...and something is still shown when neither is usable.
  assert.match(
    renderToStaticMarkup(
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
        anthropicSlowMode: { stage: "low_priority", resetsAtSec: null },
      }),
    ),
    /class="composer-slow-mode-badge"[^>]*>low priority</,
  );
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onModelChange() {},
      isStreaming: false,
      modelError: "Invalid models.json schema",
      modelList: [],
      modelNames: {},
    }),
  );

  assert.match(html, />(No models|chatInput\.noModels)</);
});


test("renders goal, planning, and advisor indicators at the composer", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onModelChange() {},
      isStreaming: false,
      model: { provider: "test", modelId: "model" },
      modelList: [{ provider: "test", modelId: "model", id: "model", name: "Test model" }],
      modelNames: {},
      activeGoal: { objective: "Ship the active goal bar", startedAt: 0 },
      activePlan: { objective: "Plan the implementation" },
      advisorEnabled: true,
      onAdvisorChange() {},
    }),
  );

  assert.match(html, /Ship the active goal bar/);
  assert.match(html, /(Planning in progress|chatInput\.planningInProgress)/);
  // The advisor toggle now lives inside the collapsed "+" menu, so a closed
  // render shows the menu button (collapsed) instead of the pressed toggle.
  assert.doesNotMatch(html, /aria-pressed/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
});

test("renders the compact toolbar action", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onCompact() {},
      isStreaming: false,
    }),
  );

  assert.match(html, /aria-label="Context"/);
});

test("shows the advisor thunder indicator with the reviewing model and reasoning", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: true,
      advisorActive: true,
      advisorModel: { name: "GPT-5.6 Luna", reasoning: "xhigh" },
    }),
  );

  assert.match(html, /aria-label="[^"]*GPT-5\.6 Luna[^"]*xhigh[^"]*"/);
});

test("filters model options by display name, identifier, and provider", () => {
  const options = [
    { provider: "OpenAI", modelId: "gpt-5.2", name: "GPT-5.2" },
    { provider: "Anthropic", modelId: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  ];

  assert.deepEqual(filterModelOptions(options, "sonnet", "en"), [options[1]]);
  assert.deepEqual(filterModelOptions(options, "5.2", "en"), [options[0]]);
  assert.deepEqual(filterModelOptions(options, "OPENAI", "en"), [options[0]]);
  assert.equal(filterModelOptions(options, "   ", "en"), options);
});
test("queued slash commands gate /advisor behind the per-chat toggle", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const sendQueued = source.slice(
    source.indexOf("const sendQueued = useCallback"),
    source.indexOf("const primaryActionQueuesMessage"),
  );
  const guard = sendQueued.indexOf('commandName === "advisor" && !advisorEnabled');
  const expansion = sendQueued.indexOf("expandWebSlashCommand(msg)");

  assert.ok(guard > 0, "advisor guard missing from sendQueued");
  assert.ok(expansion > guard, "advisor guard must run before command expansion");
});
test("slash palette follows the caret so commands trigger after typed text", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

  // The palette must key off the caret token (extractSlashQuery), never the
  // whole-input prefix check that broke "/" after real text.
  assert.match(source, /extractSlashQuery/);
  assert.doesNotMatch(source, /value\.startsWith\("\/"\) && !\\\/\\s\\\/\.test/);
  assert.match(source, /updateSlashQuery\(e\.target\.value, e\.target\.selectionStart\)/);

  // Selecting a command replaces only the slash token and keeps the prefix.
  const apply = source.slice(source.indexOf("const applySlashCommand"), source.indexOf("const sendQueued"));
  assert.match(apply, /value\.slice\(0, start\)/);
  assert.match(apply, /before \+ `\/\$\{command\.name\} ` \+ after/);
});

test("renders single queued prompt in compact bar", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: true,
      queuedMessages: {
        followUp: ["First follow-up task"],
        steering: [],
      },
    }),
  );

  assert.match(html, /First follow-up task/);
  assert.match(html, />(Edit|chatInput\.queuedEdit)</);
  assert.match(html, />(Delete|chatInput\.queuedDelete)</);
  assert.match(html, />(Steer|chatInput\.queuedSteerAction)</);
});

test("keeps editing and deletion but hides Steer for a single queued steer", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: true,
      queuedMessages: {
        followUp: [],
        steering: ["Already prioritized task"],
      },
    }),
  );

  assert.match(html, /Already prioritized task/);
  assert.match(html, />(Edit|chatInput\.queuedEdit)</);
  assert.match(html, />(Delete|chatInput\.queuedDelete)</);
  assert.doesNotMatch(html, />(Steer|chatInput\.queuedSteerAction)</);
});

test("renders multiple queued prompts with count and expand action", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: true,
      queuedMessages: {
        followUp: ["First task", "Second task"],
        steering: ["Priority steer"],
      },
    }),
  );

  assert.match(html, /\(3\)/);
  assert.match(html, />(Show all queued prompts|Show all|chatInput\.expandQueued)</);
  assert.match(html, /First task/);
});

// The merged composer row is the single goal surface: a live native goal
// (omp >= 18.4.11) takes the themed row over — omp's status drives which
// controls appear, the token readout honors the Interface & Behavior pref,
// and the web /goal marker must not leak a second line under it.
test("native goal takes the composer row over with status-driven controls", () => {
  const goal = { id: "g1", objective: "Verify the merged goal row", status: "active", tokensUsed: 1500, timeUsedSeconds: 95 };
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      goalInfo: goal,
      activeGoal: { objective: "Verify the merged goal row", startedAt: 0 },
      onGoalCommand: async () => {},
    }),
  );
  assert.match(html, /Verify the merged goal row/);
  assert.match(html, /(Active|goal\.status\.active)/);
  assert.match(html, /aria-label="(Pause goal|goal\.pause)"/);
  assert.doesNotMatch(html, /aria-label="(Resume goal|goal\.resume)"/);
  assert.match(html, /aria-label="(Drop goal|goal\.drop)"/);
  // No token readout without the preference; no marker line under a native goal.
  assert.doesNotMatch(html, /1\.5k/);
  assert.doesNotMatch(html, /Goal active|chatInput\.goalActive/);
});

test("paused native goal shows Resume, active goal never does", () => {
  const base = { id: "g1", objective: "Paused goal", tokensUsed: 0, timeUsedSeconds: 10 };
  const paused = renderToStaticMarkup(
    React.createElement(ChatInput, { onSend() {}, onAbort() {}, goalInfo: { ...base, status: "paused" }, onGoalCommand: async () => {} }),
  );
  assert.match(paused, /aria-label="(Resume goal|goal\.resume)"/);
  assert.doesNotMatch(paused, /aria-label="(Pause goal|goal\.pause)"/);
});

test("token readout renders only with the goal-token-budget preference", () => {
  const goal = { id: "g1", objective: "Budgeted goal", status: "active", tokensUsed: 59425, tokenBudget: 50000, timeUsedSeconds: 60 };
  const on = renderToStaticMarkup(
    React.createElement(ChatInput, { onSend() {}, onAbort() {}, goalInfo: goal, onGoalCommand: async () => {}, showGoalTokenBudget: true }),
  );
  assert.match(on, /59k \/ 50k/);
  const off = renderToStaticMarkup(
    React.createElement(ChatInput, { onSend() {}, onAbort() {}, goalInfo: goal, onGoalCommand: async () => {}, showGoalTokenBudget: false }),
  );
  assert.doesNotMatch(off, /59k/);
});
