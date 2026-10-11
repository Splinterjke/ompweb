import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import { installRequestPeerTracking, verifiedRequestPeer } from "./request-peer.js";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { proxy } = await jiti.import("../proxy.ts");
const { NextRequest } = await import("next/server.js");

test("actual loopback HTTP reaches proxy; unsigned Host/socket spoof cannot issue tokens", async (t) => {
  installRequestPeerTracking();
  const saved = {
    trusted: process.env.OMP_WEB_TRUSTED_PROXY,
    plain: process.env.OMP_WEB_PASSWORD,
    hash: process.env.OMP_WEB_PASSWORD_HASH,
  };
  delete process.env.OMP_WEB_TRUSTED_PROXY;
  // Hash-only model: a plaintext OMP_WEB_PASSWORD in the ambient environment
  // is a broken configuration (every request 503s), not a gate. The pairing
  // assertions need an unconfigured server, so run against a clean slate.
  delete process.env.OMP_WEB_PASSWORD;
  delete process.env.OMP_WEB_PASSWORD_HASH;
  t.after(() => {
    for (const [name, value] of [
      ["OMP_WEB_TRUSTED_PROXY", saved.trusted],
      ["OMP_WEB_PASSWORD", saved.plain],
      ["OMP_WEB_PASSWORD_HASH", saved.hash],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  assert.equal(verifiedRequestPeer(new Headers({ "x-ompweb-socket-peer": "127.0.0.1", "x-ompweb-socket-proof": "0".repeat(64) })), null);
  const server = http.createServer((incoming, response) => {
    const request = new NextRequest("http://localhost/api/pair/token", { method: "POST", headers: incoming.headers });
    const result = proxy(request);
    response.writeHead(result.status).end(JSON.stringify({ allowed: result.headers.get("x-middleware-next") === "1", peer: verifiedRequestPeer(request.headers) }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const body = await new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port: server.address().port, headers: { host: "localhost", "x-ompweb-socket-peer": "192.0.2.1", "x-ompweb-socket-proof": "forged" } }, res => {
      let data = ""; res.on("data", chunk => data += chunk); res.on("end", () => resolve(JSON.parse(data)));
    }).on("error", reject);
  });
  assert.deepEqual(body, { allowed: true, peer: "127.0.0.1" });
  const remote = new NextRequest("http://192.0.2.1/api/pair/token", { method: "POST", headers: { host: "localhost", "x-ompweb-socket-peer": "127.0.0.1", "x-ompweb-socket-proof": "0".repeat(64) } });
  assert.equal(proxy(remote).status, 403);
});

test("password gate: loopback /api/ui/refresh is exempt; remote caller still 401s", async (t) => {
  installRequestPeerTracking();
  const { hashPassword } = createRequire(import.meta.url)("./omp-web-password-hash.js");
  const saved = {
    plain: process.env.OMP_WEB_PASSWORD,
    hash: process.env.OMP_WEB_PASSWORD_HASH,
    digest: process.env.OMP_WEB_TRUSTED_HEADER_SHA256,
  };
  // The gate is keyed by the scrypt hash (OMP_WEB_PASSWORD_HASH); a plaintext
  // value is refused as a configuration error, and a trusted-proxy digest in
  // the ambient environment would vouch the "remote" request open.
  delete process.env.OMP_WEB_PASSWORD;
  delete process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
  process.env.OMP_WEB_PASSWORD_HASH = hashPassword("ompweb-test-secret", { logN: 12 });
  t.after(() => {
    for (const [name, value] of [
      ["OMP_WEB_PASSWORD", saved.plain],
      ["OMP_WEB_PASSWORD_HASH", saved.hash],
      ["OMP_WEB_TRUSTED_HEADER_SHA256", saved.digest],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  // A real loopback POST (no session cookie) must pass the password gate.
  const server = http.createServer((incoming, response) => {
    const request = new NextRequest("http://localhost/api/ui/refresh", { method: "POST", headers: incoming.headers });
    const result = proxy(request);
    response.writeHead(result.status).end(JSON.stringify({ allowed: result.headers.get("x-middleware-next") === "1" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const loopback = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, method: "POST", headers: { host: "localhost", "content-type": "application/json" } }, res => {
      let data = ""; res.on("data", chunk => data += chunk); res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal(loopback.allowed, true, "loopback /api/ui/refresh must be exempted from the password gate");
  // A remote caller forging loopback peer/proof headers must be denied 401.
  const remote = new NextRequest("http://192.0.2.1/api/ui/refresh", {
    method: "POST",
    headers: { host: "localhost", "x-ompweb-socket-peer": "127.0.0.1", "x-ompweb-socket-proof": "0".repeat(64) },
  });
  const denied = proxy(remote);
  assert.equal(denied.status, 401, "remote /api/ui/refresh with forged loopback headers must 401");
});
