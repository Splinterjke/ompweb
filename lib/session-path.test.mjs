import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./paths.ts");
}

test("preserves case when session paths are case-sensitive", async () => {
  const { sessionPathKey } = await loadSubject();

  assert.notEqual(
    sessionPathKey("/var/lib/pi/Parent.jsonl", "linux"),
    sessionPathKey("/var/lib/pi/parent.jsonl", "linux"),
  );
});
