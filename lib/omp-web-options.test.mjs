import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseLaunchOptions } = require("../bin/omp-web-options.js");

test("opens the browser by default", () => {
  const parsed = parseLaunchOptions([], {});
  assert.equal(parsed.port, "30177");
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.openBrowser, true);
});

test("supports the no-open CLI option", () => {
  assert.equal(parseLaunchOptions(["--no-open"], {}).openBrowser, false);
});

test("supports truthy OMP_WEB_NO_OPEN values", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(parseLaunchOptions([], { OMP_WEB_NO_OPEN: value }).openBrowser, false);
  }
});

test("does not disable browser opening for false OMP_WEB_NO_OPEN values", () => {
  for (const value of ["0", "false", "off", ""]) {
    assert.equal(parseLaunchOptions([], { OMP_WEB_NO_OPEN: value }).openBrowser, true);
  }
});

test("preserves port and hostname options", () => {
  const parsed = parseLaunchOptions(["-p", "8080", "-H", "0.0.0.0"], {});
  assert.equal(parsed.port, "8080");
  assert.equal(parsed.hostname, "0.0.0.0");
  assert.equal(parsed.openBrowser, true);
});

test("supports OMP_WEB_HOSTNAME without trusting the ambient system HOSTNAME", () => {
  assert.equal(
    parseLaunchOptions([], { HOSTNAME: "container-id" }).hostname,
    "127.0.0.1",
  );
  assert.equal(
    parseLaunchOptions([], { OMP_WEB_HOSTNAME: "0.0.0.0" }).hostname,
    "0.0.0.0",
  );
});

test("accepts a password hash from OMP_WEB_PASSWORD_HASH", () => {
  const hash = "scrypt$15$8$1$WlVEVcJQz1dJIPZ4AlRrFQ$8CFi0lDZHh1Gr6gAWOi0yBVJXxbFCL0-w5u_5zADk1E";
  assert.equal(parseLaunchOptions([], {}).passwordHash, undefined);
  assert.equal(parseLaunchOptions([], { OMP_WEB_PASSWORD_HASH: hash }).passwordHash, hash);
  // Values arrive through .env files and service units, where a trailing
  // newline or quote is an easy mistake; trimming keeps `ompweb` starting.
  assert.equal(parseLaunchOptions([], { OMP_WEB_PASSWORD_HASH: `  ${hash}\n` }).passwordHash, hash);
});

test("flags a legacy plaintext password instead of accepting it", () => {
  assert.equal(parseLaunchOptions([], {}).legacyPassword, undefined);
  assert.deepEqual(
    (({ legacyPassword, legacyPasswordSource }) => ({ legacyPassword, legacyPasswordSource }))(
      parseLaunchOptions([], { OMP_WEB_PASSWORD: "secret" }),
    ),
    { legacyPassword: "secret", legacyPasswordSource: "env" },
  );
  assert.deepEqual(
    (({ legacyPassword, legacyPasswordSource }) => ({ legacyPassword, legacyPasswordSource }))(
      parseLaunchOptions(["--password", "from-cli"], { OMP_WEB_PASSWORD: "from-env" }),
    ),
    { legacyPassword: "from-cli", legacyPasswordSource: "flag" },
  );
  assert.deepEqual(
    (({ legacyPassword, legacyPasswordSource }) => ({ legacyPassword, legacyPasswordSource }))(
      parseLaunchOptions(["--password=inline"], {}),
    ),
    { legacyPassword: "inline", legacyPasswordSource: "flag" },
  );
  // An empty value is not a configured password.
  assert.equal(parseLaunchOptions([], { OMP_WEB_PASSWORD: "" }).legacyPassword, undefined);
});

test("--password is no longer a declared option", () => {
  // The parser must not swallow a following argument as the password value.
  const parsed = parseLaunchOptions(["--password", "secret"], {});
  assert.equal(parsed.passwordHash, undefined);
  assert.equal(parsed.port, "30177");
});
