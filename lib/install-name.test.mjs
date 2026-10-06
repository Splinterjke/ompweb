import assert from "node:assert/strict";
import test from "node:test";
import { getInstallName } from "./install-name.ts";

test("uses the host without its port as the installation name", () => {
  assert.equal(getInstallName(new Headers({ host: "work.example.com:30177" })), "work.example.com");
});

test("keeps named LAN hosts as installation names", () => {
  assert.equal(getInstallName(new Headers({ host: "devbox:30177" })), "devbox");
  assert.equal(getInstallName(new Headers({ host: "devbox.local:30177" })), "devbox.local");
});

test("uses the generic name for localhost and IP addresses", () => {
  for (const host of ["localhost:30177", "LOCALHOST.:30177", "127.0.0.1:30177", "192.168.1.10", "[::1]:30177", "[2001:db8::1]:30177"]) {
    assert.equal(getInstallName(new Headers({ host })), "omp web", host);
  }
});

test("falls back to the generic name when Host is missing or malformed", () => {
  assert.equal(getInstallName(new Headers()), "omp web");
  assert.equal(getInstallName(new Headers({ host: "[broken" })), "omp web");
});

test("rejects Host values URL.parse would silently truncate", () => {
  // "@", "#", "?", "/", backslash and whitespace are illegal in Host; the
  // parser strips userinfo/fragments/queries instead of failing, so a name
  // derived from the remainder would look plausible but be wrong.
  for (const host of [
    "user@evil.com:80",
    "user:pass@evil.com:80",
    "evil.com#@good.com",
    "evil.com?x=<script>",
    "http://evil.com",
    "evil.com\\good.com",
    "e vil.com",
  ]) {
    assert.equal(getInstallName(new Headers({ host })), "omp web", host);
  }
});

test("treats localhost subdomains as localhost", () => {
  for (const host of ["foo.localhost", "foo.localhost.", "FOO.LOCALHOST:30177"]) {
    assert.equal(getInstallName(new Headers({ host })), "omp web", host);
  }
  // ...but a domain that merely contains the word is a real, distinct host.
  assert.equal(getInstallName(new Headers({ host: "localhost.evil.com" })), "localhost.evil.com");
});
