import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseTodoPhases, normalizeTodoPhases } = await jiti.import("./todo-phases.ts");

// The exact state omp 18.8.9 stored in session 01a12770-b83b-750b-a684-88c3753275fe
// after a model nested {phase, items} objects inside `todo init`'s `items`:
// omp stringified each object into one task under the default "Tasks" phase.
const implementPhase = {
  phase: "Implement",
  items: [
    "DiffViewer: Wrap lines default ON + independent toggle; rename Unified view → Inline view",
    "Fix right-panel drag resize stalling over the git-graph iframe (pointer-events during drag)",
    "GitChangesPanel: remove old file-info header row; add status label to DiffViewer header",
  ],
};
const verifyPhase = {
  phase: "Verify",
  items: [
    "Tests + tsc + eslint green; visual check on throwaway mirror for all three changes",
    "Commit each change; clean up scaffolds",
  ],
};
const mangledTasks = (status = "pending") => [
  { content: JSON.stringify(implementPhase), status },
  { content: JSON.stringify(verifyPhase), status },
];

test("re-expands the mangled init tasks into their declared phases", () => {
  const normalized = normalizeTodoPhases([{ name: "Tasks", tasks: mangledTasks() }]);
  assert.deepEqual(normalized, [
    { name: "Implement", tasks: implementPhase.items.map((content) => ({ content, status: "pending" })) },
    { name: "Verify", tasks: verifyPhase.items.map((content) => ({ content, status: "pending" })) },
  ]);
  // No task text may still be raw JSON.
  assert.equal(normalized.some((phase) => phase.tasks.some((task) => task.content.startsWith("{"))), false);
});

test("drops zero-task phases so the ghost 0/0 bar cannot render", () => {
  assert.deepEqual(normalizeTodoPhases([{ name: "Tasks", tasks: [] }]), []);
  assert.deepEqual(
    normalizeTodoPhases([
      { name: "Empty", tasks: [] },
      { name: "Real", tasks: [{ content: "Keep", status: "pending" }] },
    ]),
    [{ name: "Real", tasks: [{ content: "Keep", status: "pending" }] }],
  );
  // A phase emptied BY the rescue (all its tasks expanded elsewhere) is dropped too.
  assert.deepEqual(normalizeTodoPhases([{ name: "Tasks", tasks: mangledTasks() }]).map((phase) => phase.name), [
    "Implement",
    "Verify",
  ]);
});

test("passes well-formed snapshots through untouched and stays idempotent", () => {
  const wellFormed = [
    {
      name: "Plan",
      tasks: [
        { content: "Plain task", status: "in_progress" },
        { content: '{"looks":"like json","but":"no items array"}', status: "completed" },
        { content: "Blocked task", status: "blocked", blocker: "Waiting on review" },
      ],
    },
  ];
  const normalized = normalizeTodoPhases(wellFormed);
  assert.deepEqual(normalized, wellFormed);
  assert.deepEqual(normalizeTodoPhases(normalized), normalized);
});

test("leaves contents that are not phase-shaped JSON verbatim", () => {
  for (const content of [
    '{"foo":1}',                       // JSON, but not {…, items: []}
    '{"items":"not an array"}',        // items must be an array
    '{"phase":"X","items":[',          // unparseable
    `[${JSON.stringify({ phase: "A", items: ["x"] })}]`, // top-level array is not an init item
    `{"phase":"X","items":["x"]}${"y".repeat(8192)}`,    // over the parse cap
  ]) {
    const normalized = normalizeTodoPhases([{ name: "H", tasks: [{ content, status: "pending" }] }]);
    assert.deepEqual(normalized, [{ name: "H", tasks: [{ content, status: "pending" }] }], `keeps: ${content.slice(0, 40)}`);
  }
});

test("items without a phase name inherit the host phase and task status", () => {
  const content = JSON.stringify({ items: ["First", "Second"] });
  const normalized = normalizeTodoPhases([{ name: "MyPlan", tasks: [{ content, status: "in_progress" }] }]);
  assert.deepEqual(normalized, [
    {
      name: "MyPlan",
      tasks: [
        { content: "First", status: "in_progress" },
        { content: "Second", status: "in_progress" },
      ],
    },
  ]);
});

test("mixed tasks keep order, same-named expansions merge", () => {
  const deep = { phase: "Deep", items: ["d1"] };
  const normalized = normalizeTodoPhases([
    {
      name: "H",
      tasks: [
        { content: "before", status: "pending" },
        { content: JSON.stringify({ items: [{ phase: "Deep", items: ["d1"] }, "plain"] }), status: "pending" },
        { content: "after", status: "completed" },
        { content: JSON.stringify(deep), status: "pending" },
      ],
    },
  ]);
  assert.deepEqual(normalized, [
    {
      name: "H",
      tasks: [
        { content: "before", status: "pending" },
        { content: "plain", status: "pending" },
        { content: "after", status: "completed" },
      ],
    },
    {
      name: "Deep",
      tasks: [
        { content: "d1", status: "pending" },
        { content: "d1", status: "pending" },
      ],
    },
  ]);
});

test("invalid structures return null so readers fall back to older snapshots", () => {
  assert.equal(normalizeTodoPhases(null), null);
  assert.equal(normalizeTodoPhases({}), null);
  assert.equal(normalizeTodoPhases([{ name: "P" }]), null);
  assert.equal(normalizeTodoPhases([{ name: "P", tasks: [{ content: "x" }] }]), null);
  assert.equal(normalizeTodoPhases([{ name: "P", tasks: [{ content: "x", status: "cancelled" }] }]), null);
  assert.equal(parseTodoPhases([{ name: "P", tasks: [] }])?.length, 1);
  // parseTodoPhases validates only — the rescue belongs to normalizeTodoPhases.
  assert.deepEqual(parseTodoPhases([{ name: "Tasks", tasks: mangledTasks() }]), [
    { name: "Tasks", tasks: mangledTasks() },
  ]);
});
