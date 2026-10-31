import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// The mid-run titling talks to `omp auth-gateway stdio`'s /v1/chat/completions
// route. The omp binary is a stub speaking that JSON-lines protocol and
// logging every request it sees — the same harness as lib/stt-omp-gateway.test.mjs.

const dir = mkdtempSync(join(tmpdir(), "omp-web-title-gateway-"));
const log = join(dir, "gateway.log");
const fakeOmp = join(dir, "fake-omp");
writeFileSync(
  fakeOmp,
  `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const log = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + "\\n");
log({ launch: process.argv.slice(2) });
process.stdout.write(JSON.stringify({ ready: true, version: "test" }) + "\\n");
const replies = {
  "@tiny": { status: 401, body: { error: { message: "No credential available for provider tiny" } } },
  "@commit": { status: 200, body: { choices: [{ message: { content: "Fix the login bug" } }] } },
  "@smol": { status: 200, body: { choices: [{ message: { content: [{ type: "text", text: "<title>Names the parser fix</title>" }] } }] } },
  "all/fail": { status: 404, body: { error: { message: "Unknown model" } } },
};
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, path, body } = JSON.parse(line);
  log({ path, body });
  const reply = replies[body.model] ?? { status: 500, body: { error: { message: "unexpected model" } } };
  process.stdout.write(JSON.stringify({ id, ...reply }) + "\\n");
});
`,
  { mode: 0o755 },
);

const originalEnv = { ...process.env };
process.env.OMP_WEB_OMP_BIN = fakeOmp;
const { generateOpenerTitle } = await import("./title-generator.ts");
const { disposeAuthGateway } = await import("./auth-gateway.ts");

after(() => {
  disposeAuthGateway();
  process.env = originalEnv;
  rmSync(dir, { recursive: true, force: true });
});

test(
  "the chain walks the role selectors, stops at the first usable title, and asks the native-shaped question",
  { skip: process.platform === "win32" },
  async () => {
    const generated = await generateOpenerTitle({
      text: "fix the login bug in auth.ts",
      modelChain: ["@tiny", "@commit", "@smol"],
    });
    assert.deepEqual(generated, { title: "Fix the login bug", model: "@commit" });

    const entries = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(entries.find((entry) => entry.launch).launch, ["auth-gateway", "stdio"]);
    const requests = entries.filter((entry) => entry.path);
    assert.equal(requests.length, 2, "the chain stops at the first success");
    assert.equal(requests[0].path, "/v1/chat/completions");
    assert.equal(requests[0].body.model, "@tiny");
    assert.equal(requests[1].body.model, "@commit");
    const first = requests[0].body;
    assert.equal(first.max_tokens, 1024);
    assert.equal(first.temperature, 0);
    assert.equal(first.stream, false);
    assert.equal(first.messages.length, 2);
    assert.equal(first.messages[0].role, "system");
    assert.equal(first.messages[1].role, "user");
    assert.equal(first.messages[1].content, "<user> fix the login bug in auth.ts </user>");
  },
);

test("a completion whose text carries <title> tags parses through the native-style parser", { skip: process.platform === "win32" }, async () => {
  const generated = await generateOpenerTitle({ text: "why is parser_test.py red", modelChain: ["@smol"] });
  assert.deepEqual(generated, { title: "Names the parser fix", model: "@smol" });
});

test("every candidate missing names nothing (the settle path stays the backstop)", { skip: process.platform === "win32" }, async () => {
  const generated = await generateOpenerTitle({ text: "fix something", modelChain: ["all/fail", "all/fail2"] });
  assert.equal(generated, null);
});
