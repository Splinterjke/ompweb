import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { planLogout } = await jiti.import("./auth-logout.ts");

const account = (credentialId, active = false) => ({
  credentialId,
  provider: "anthropic",
  label: `acct-${credentialId}`,
  detail: `detail-${credentialId}`,
  type: "oauth",
  active,
});

test("no stored accounts plans nothing to remove", () => {
  assert.deepEqual(planLogout([]), { kind: "none" });
  assert.deepEqual(planLogout([], 7), { kind: "none" });
});

test("a single stored account is removed without a choice", () => {
  assert.deepEqual(planLogout([account(3)]), { kind: "logout", credentialId: 3 });
  assert.deepEqual(planLogout([account(3, true)]), { kind: "logout", credentialId: 3 });
});

test("several accounts force an explicit choice (never a silent disconnect)", () => {
  const accounts = [account(1), account(2, true), account(3)];
  assert.deepEqual(planLogout(accounts), { kind: "choose", accounts });
});

test("an explicitly requested credential is honored when stored", () => {
  const accounts = [account(1), account(2), account(3)];
  assert.deepEqual(planLogout(accounts, 2), { kind: "logout", credentialId: 2 });
});

test("a requested credential that is not stored reports not_found with the live list", () => {
  const accounts = [account(1), account(2)];
  const plan = planLogout(accounts, 99);
  assert.equal(plan.kind, "not_found");
  assert.deepEqual(plan.accounts, accounts);
});

test("a requested credential against an empty account list still plans none", () => {
  // An unknown credential must never reach omp's `logout` command; the
  // provider simply has nothing stored.
  assert.deepEqual(planLogout([], 5), { kind: "none" });
});
