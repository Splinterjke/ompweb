import assert from "node:assert/strict";
import test from "node:test";
import { getInstallName } from "./install-name.ts";

const fromHost = (host) => getInstallName(new Headers(host === undefined ? {} : { host }), { OMP_WEB_NAME: "url" });

test("keeps the generic name when OMP_WEB_NAME is unset or blank, whatever the Host", () => {
  const headers = new Headers({ host: "work.example.com" });
  assert.equal(getInstallName(headers, {}), "omp web");
  assert.equal(getInstallName(headers, { OMP_WEB_NAME: "" }), "omp web");
  assert.equal(getInstallName(headers, { OMP_WEB_NAME: "  " }), "omp web");
});

test("uses any other OMP_WEB_NAME verbatim, trimmed, ignoring the Host", () => {
  const headers = new Headers({ host: "work.example.com" });
  assert.equal(getInstallName(headers, { OMP_WEB_NAME: " My Box " }), "My Box");
  assert.equal(getInstallName(headers, { OMP_WEB_NAME: "hostname" }), "hostname");
  assert.equal(getInstallName(headers, { OMP_WEB_NAME: "urls" }), "urls");
});

test("derives the name from the Host for url, host or domain, case-insensitively", () => {
  const headers = new Headers({ host: "work.example.com:30177" });
  for (const OMP_WEB_NAME of ["url", "URL", "host", "Host", "domain", " DOMAIN "]) {
    assert.equal(getInstallName(headers, { OMP_WEB_NAME }), "work.example.com", OMP_WEB_NAME);
  }
});

test("Host mode keeps named LAN hosts", () => {
  assert.equal(fromHost("devbox:30177"), "devbox");
  assert.equal(fromHost("devbox.local:30177"), "devbox.local");
});

test("Host mode uses the generic name for localhost and IP addresses", () => {
  for (const host of ["localhost:30177", "LOCALHOST.:30177", "127.0.0.1:30177", "192.168.1.10", "[::1]:30177", "[2001:db8::1]:30177"]) {
    assert.equal(fromHost(host), "omp web", host);
  }
});

test("Host mode falls back to the generic name when Host is missing or malformed", () => {
  assert.equal(fromHost(undefined), "omp web");
  assert.equal(fromHost("[broken"), "omp web");
});

test("Host mode rejects Host values URL.parse would silently truncate", () => {
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
    assert.equal(fromHost(host), "omp web", host);
  }
});

test("Host mode treats localhost subdomains as localhost", () => {
  for (const host of ["foo.localhost", "foo.localhost.", "FOO.LOCALHOST:30177"]) {
    assert.equal(fromHost(host), "omp web", host);
  }
  // ...but a domain that merely contains the word is a real, distinct host.
  assert.equal(fromHost("localhost.evil.com"), "localhost.evil.com");
});
