import assert from "node:assert/strict";
import test from "node:test";
import { modelConfigSecretInputValue, omitUntouchedModelDrafts, preserveModelConfigSecret } from "./models-config-drafts.ts";

test("omits only untouched new-model rows before saving provider edits", () => {
  const config = {
    providers: {
      openai: { apiKey: "updated", models: [{ id: "" }] },
      configured: { models: [{ id: "gpt-5" }] },
      incomplete: { models: [{ id: "", name: "Draft name" }] },
    },
  };

  assert.deepEqual(omitUntouchedModelDrafts(config), {
    providers: {
      openai: { apiKey: "updated", models: undefined },
      configured: { models: [{ id: "gpt-5" }] },
      incomplete: { models: [{ id: "", name: "Draft name" }] },
    },
  });
});

test("keeps redacted model secrets unless the user replaces them", () => {
  const marker = "__OMPWEB_REDACTED__";
  assert.equal(modelConfigSecretInputValue(marker), "");
  assert.equal(preserveModelConfigSecret("", marker), marker);
  assert.equal(preserveModelConfigSecret("replacement", marker), "replacement");
});
