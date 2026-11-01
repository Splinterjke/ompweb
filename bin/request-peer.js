"use strict";

// The socket peer of an incoming request, stamped at the HTTP boundary so no
// client can claim loopback by sending a header. The Bun server stamps with
// `requestPeerHeaders` (server.requestIP) before the gate and handlers run;
// `verifiedRequestPeer` is the only accepted reader of the stamp.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { randomBytes, createHmac, timingSafeEqual } = require("node:crypto");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isIP } = require("node:net");
const PEER_HEADER = "x-ompweb-socket-peer";
const PROOF_HEADER = "x-ompweb-socket-proof";

function verifiedRequestPeer(headers) {
  const peer = headers.get(PEER_HEADER);
  const proof = headers.get(PROOF_HEADER);
  const secret = process.env.OMPWEB_PEER_SECRET;
  if (!secret || !peer || !isIP(peer) || !proof || !/^[a-f0-9]{64}$/.test(proof)) return null;
  const expected = createHmac("sha256", secret).update(peer).digest();
  return timingSafeEqual(expected, Buffer.from(proof, "hex")) ? peer : null;
}

/**
 * Header stamp for a request whose socket peer is `peer` (null when the
 * server could not resolve one). A `null` value means "delete the header",
 * so client-supplied peer claims are always dropped first.
 */
function requestPeerHeaders(peer) {
  const headers = { [PEER_HEADER]: null, [PROOF_HEADER]: null };
  if (peer && isIP(peer)) {
    const secret = process.env.OMPWEB_PEER_SECRET || (process.env.OMPWEB_PEER_SECRET = randomBytes(32).toString("hex"));
    headers[PEER_HEADER] = peer;
    headers[PROOF_HEADER] = createHmac("sha256", secret).update(peer).digest("hex");
  }
  return headers;
}

module.exports = { verifiedRequestPeer, requestPeerHeaders };
