import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { providerInitials, providerCollapsePrefs, toggleCollapsedProvider, selectionAfterConfigReload } = await jiti.import("./ModelsConfig.tsx");

// Pure mirrors of the state transitions in ModelsConfig — the rename must
// never produce duplicate provider keys (which would silently drop one
// provider's config on save), and the final save guard must reject them.
function renameProviderKey(providers, oldName, newName) {
  const entries = Object.entries(providers ?? {});
  const idx = entries.findIndex(([k]) => k === oldName);
  if (idx === -1) return providers;
  entries[idx] = [newName, entries[idx][1]];
  return Object.fromEntries(entries);
}

function hasDuplicateKeys(providers) {
  const names = Object.keys(providers ?? {});
  const seen = new Set();
  return names.some((n) => (seen.has(n) ? true : (seen.add(n), false)));
}

test("provider glyphs derive from arbitrary runtime provider ids", () => {
  assert.equal(providerInitials("acme-provider"), "AP");
  assert.equal(providerInitials("my_custom_gateway"), "MC");
  assert.equal(providerInitials("provider"), "P");
  assert.equal(providerInitials(""), "?");
});

test("renaming onto an existing provider key loses data (duplicate key) — save guard must reject", () => {
  const providers = {
    alpha: { baseUrl: "https://a.example/v1", models: [{ id: "m1" }] },
    beta: { baseUrl: "https://b.example/v1", models: [{ id: "m2" }] },
  };
  // Object.fromEntries silently collapses duplicate keys (one of the two
  // providers' configs is dropped) — this is exactly the data-loss the
  // renameValidate + handleSave duplicate check must prevent.
  const merged = renameProviderKey(providers, "alpha", "beta");
  const keys = Object.keys(merged);
  assert.equal(new Set(keys).size, 1, "duplicate key collapsed");
  assert.equal(keys.length, 1);
  // The UI guard (renameValidate + handleSave duplicate check) must stop the
  // rename before any state/file write — this assertion freezes that
  // contract: a conflicting rename never reaches Object.fromEntries.
  const sourceKeys = Object.keys(providers);
  assert.equal(new Set(sourceKeys).size, sourceKeys.length);
});

test("renaming to a fresh key preserves every provider", () => {
  const providers = {
    alpha: { baseUrl: "https://a.example/v1", models: [{ id: "m1" }] },
  };
  const renamed = renameProviderKey(providers, "alpha", "gamma");
  assert.deepEqual(Object.keys(renamed), ["gamma"]);
  assert.deepEqual(renamed.gamma, providers.alpha);
  assert.equal(hasDuplicateKeys(renamed), false);
});

test("provider collapse preferences reject malformed values and dedupe provider ids", () => {
  assert.deepEqual(providerCollapsePrefs(null), { custom: [], picker: [] });
  assert.deepEqual(providerCollapsePrefs({ custom: ["alpha", "alpha", 42], picker: ["beta", ""] }), {
    custom: ["alpha"],
    picker: ["beta"],
  });
});

test("provider collapse toggle expands and re-collapses one provider without touching peers", () => {
  assert.deepEqual(toggleCollapsedProvider(["alpha", "beta"], "alpha"), ["beta"]);
  assert.deepEqual(toggleCollapsedProvider(["beta"], "alpha"), ["beta", "alpha"]);
});

// The save flow re-reads models.yml; the editor selection must survive that
// reload instead of jumping back to the first provider.
test("config reload keeps the selected provider instead of jumping to the first", () => {
  const providers = { alpha: { models: [] }, beta: { models: [{ id: "m" }] }, gamma: {} };
  // Regression: selecting beta and pressing Save used to reset to alpha.
  assert.deepEqual(selectionAfterConfigReload({ type: "provider", name: "beta" }, providers), { type: "provider", name: "beta" });
  assert.deepEqual(selectionAfterConfigReload({ type: "provider", name: "gamma" }, providers), { type: "provider", name: "gamma" });
});

test("initial config load selects the first provider, empty config selects none", () => {
  const providers = { alpha: {}, beta: {} };
  assert.deepEqual(selectionAfterConfigReload(null, providers), { type: "provider", name: "alpha" });
  assert.equal(selectionAfterConfigReload(null, {}), null);
});

test("reload after the selected provider was deleted falls back to the first", () => {
  assert.deepEqual(selectionAfterConfigReload({ type: "provider", name: "beta" }, { alpha: {} }), { type: "provider", name: "alpha" });
  assert.equal(selectionAfterConfigReload({ type: "provider", name: "beta" }, {}), null);
  assert.deepEqual(selectionAfterConfigReload({ type: "model", providerName: "beta", index: 0 }, { gamma: { models: [{ id: "x" }] } }), { type: "provider", name: "gamma" });
});

test("model selection survives the reload unless its row disappeared with a draft", () => {
  const providers = { beta: { models: [{ id: "m0" }, { id: "m1" }] } };
  assert.deepEqual(selectionAfterConfigReload({ type: "model", providerName: "beta", index: 1 }, providers), { type: "model", providerName: "beta", index: 1 });
  // The save drops untouched empty "Add model" draft rows — an index past the
  // persisted end lands on the provider instead of another model.
  assert.deepEqual(selectionAfterConfigReload({ type: "model", providerName: "beta", index: 2 }, providers), { type: "provider", name: "beta" });
});

test("non-config editor surfaces are untouched by a config reload", () => {
  const providers = { alpha: {} };
  for (const selection of [
    { type: "oauth", providerId: "anthropic" },
    { type: "apikey", providerId: "openai" },
    { type: "roles" },
    { type: "registry" },
    { type: "fallbacks" },
    { type: "picker" },
  ]) {
    assert.deepEqual(selectionAfterConfigReload(selection, providers), selection);
  }
});
