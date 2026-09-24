import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../", import.meta.url).pathname,
  },
});
const { checkNpmUpdate } = await jiti.import("./npm-update.ts");
const { checkOmpUpdate } = await jiti.import("./omp/updates.ts");
const { DISABLE_AUTOUPDATE_ENV_VAR, isUpdateDisabled } = await jiti.import("./update-policy.ts");
const { GET: getAppUpdate, POST: postAppUpdate } = await jiti.import("../app/api/app-update/route.ts");
const { POST: postOmpUpdate } = await jiti.import("../app/api/omp-update/route.ts");

const ENV_VAR = DISABLE_AUTOUPDATE_ENV_VAR;

test("update opt-out accepts truthy values and leaves falsy values enabled", () => {
  for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
    assert.equal(isUpdateDisabled({ [ENV_VAR]: value }), true);
  }
  for (const value of [undefined, "", "0", "false", "off", "no"]) {
    assert.equal(isUpdateDisabled({ [ENV_VAR]: value }), false);
  }
});

test("update opt-out skips external checks and in-app update actions", async () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  process.env[ENV_VAR] = "1";
  process.env.OMP_WEB_OMP_BIN = join(tmpdir(), "omp-web-missing-omp-for-update-policy-test");
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network must not be used while updates are disabled");
  };

  try {
    const npmStatus = await checkNpmUpdate(true);
    assert.equal(npmStatus.updatesDisabled, true);
    assert.equal(npmStatus.updateAvailable, false);
    assert.equal(npmStatus.availableVersion, null);

    const ompStatus = await checkOmpUpdate();
    assert.equal(ompStatus.updatesDisabled, true);
    assert.equal(ompStatus.updateAvailable, false);
    assert.equal(ompStatus.availableVersion, null);

    const appResponse = await getAppUpdate(new Request("http://localhost/api/app-update?force=1"));
    assert.equal(appResponse.status, 200);
    const appBody = await appResponse.json();
    assert.equal(appBody.updatesDisabled, true);
    assert.equal(appBody.updateAvailable, false);

    const ompCheckResponse = await postOmpUpdate(new Request("http://localhost/api/omp-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "check" }),
    }));
    assert.equal(ompCheckResponse.status, 200);
    const ompCheckBody = await ompCheckResponse.json();
    assert.equal(ompCheckBody.updatesDisabled, true);
    assert.equal(ompCheckBody.updateAvailable, false);

    // In-app update actions are refused while the opt-out is active.
    const ompUpdateResponse = await postOmpUpdate(new Request("http://localhost/api/omp-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update" }),
    }));
    assert.equal(ompUpdateResponse.status, 403);
    assert.equal((await ompUpdateResponse.json()).code, "updates_disabled");

    const appUpdateResponse = await postAppUpdate(new Request("http://localhost/api/app-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }));
    assert.equal(appUpdateResponse.status, 403);
    assert.equal((await appUpdateResponse.json()).code, "updates_disabled");

    assert.equal(fetchCalls, 0);
  } finally {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  }
});
