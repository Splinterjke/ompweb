import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { requestPeerHeaders, verifiedRequestPeer } from "./request-peer.js";
import { proxy } from "../proxy.ts";

/** Apply the server's peer stamp to a request, exactly like the Bun server does. */
function stampedRequest(url, init, peer) {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(requestPeerHeaders(peer))) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return new Request(url, { ...init, headers });
}

function cleanGateEnv(t) {
  const saved = {
    secret: process.env.OMPWEB_PEER_SECRET,
    plain: process.env.OMP_WEB_PASSWORD,
    hash: process.env.OMP_WEB_PASSWORD_HASH,
    digest: process.env.OMP_WEB_TRUSTED_HEADER_SHA256,
    trusted: process.env.OMP_WEB_TRUSTED_PROXY,
  };
  delete process.env.OMPWEB_PEER_SECRET;
  delete process.env.OMP_WEB_PASSWORD;
  delete process.env.OMP_WEB_PASSWORD_HASH;
  delete process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
  delete process.env.OMP_WEB_TRUSTED_PROXY;
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test("the stamp round-trips through verifiedRequestPeer; forged headers verify to null", () => {
  assert.equal(verifiedRequestPeer(new Headers({ "x-ompweb-socket-peer": "127.0.0.1", "x-ompweb-socket-proof": "0".repeat(64) })), null);
  assert.equal(verifiedRequestPeer(new Headers(requestPeerHeaders(null))), null);
  const stamp = requestPeerHeaders("127.0.0.1");
  assert.equal(verifiedRequestPeer(new Headers(stamp)), "127.0.0.1");
  // Swapping the peer while keeping the proof breaks verification.
  const tampered = new Headers(stamp);
  tampered.set("x-ompweb-socket-peer", "8.8.8.8");
  assert.equal(verifiedRequestPeer(tampered), null);
});

test("the pairing gate trusts the stamped peer, not a client-supplied one", async (t) => {
  cleanGateEnv(t);
  const loopback = stampedRequest("http://localhost/api/pair/token", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", "x-ompweb-socket-peer": "192.0.2.1", "x-ompweb-socket-proof": "forged" },
  }, "127.0.0.1");
  assert.equal(verifiedRequestPeer(loopback.headers), "127.0.0.1", "the stamp replaced the forged peer");
  assert.notEqual(proxy(loopback) instanceof Response, true, "a stamped loopback pairing request must not be denied");
  // A remote caller forging a loopback peer without the HMAC proof stays remote.
  const remote = new Request("http://192.0.2.1/api/pair/token", {
    method: "POST",
    headers: { host: "localhost", "x-ompweb-socket-peer": "127.0.0.1", "x-ompweb-socket-proof": "0".repeat(64) },
  });
  assert.equal(proxy(remote).status, 403);
});

test("password gate: loopback /api/ui/refresh is exempt; remote caller still 401s", async (t) => {
  cleanGateEnv(t);
  const { hashPassword } = createRequire(import.meta.url)("./omp-web-password-hash.js");
  process.env.OMP_WEB_PASSWORD_HASH = hashPassword("ompweb-test-secret", { logN: 12 });
  // A stamped loopback POST (no session cookie) passes the password gate.
  const loopback = stampedRequest("http://localhost/api/ui/refresh", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
  }, "127.0.0.1");
  assert.notEqual(proxy(loopback) instanceof Response, true, "loopback /api/ui/refresh must be exempted from the password gate");
  // A remote caller forging loopback peer/proof headers is denied 401.
  const remote = new Request("http://192.0.2.1/api/ui/refresh", {
    method: "POST",
    headers: { host: "localhost", "x-ompweb-socket-peer": "127.0.0.1", "x-ompweb-socket-proof": "0".repeat(64) },
  });
  assert.equal(proxy(remote).status, 401, "remote /api/ui/refresh with forged loopback headers must 401");
});
