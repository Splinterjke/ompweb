"use strict";

const MIN_NODE_VERSION = "22.19.0";
const MIN_BUN_VERSION = "1.1.0";

function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareVersions(current, minimum) {
  const parsedCurrent = parseNodeVersion(current);
  const parsedMinimum = parseNodeVersion(minimum);
  if (!parsedCurrent || !parsedMinimum) return -1;

  for (let index = 0; index < parsedMinimum.length; index += 1) {
    if (parsedCurrent[index] > parsedMinimum[index]) return 1;
    if (parsedCurrent[index] < parsedMinimum[index]) return -1;
  }
  return 0;
}

function isNodeVersionSupported(version) {
  return compareVersions(version, MIN_NODE_VERSION) >= 0;
}

function isBunVersionSupported(version) {
  return compareVersions(version, MIN_BUN_VERSION) >= 0;
}

function isRuntimeSupported(versions = process.versions) {
  if (versions.bun) return isBunVersionSupported(versions.bun);
  return isNodeVersionSupported(versions.node);
}

function getUnsupportedNodeVersionMessage(version) {
  return [
    `ompweb requires Node.js ${MIN_NODE_VERSION} or newer.`,
    `Current Node.js version: ${version}.`,
    "Upgrade Node.js and try again: https://nodejs.org/",
  ].join("\n");
}

function getUnsupportedRuntimeVersionMessage(versions = process.versions) {
  if (versions.bun) {
    return [
      `ompweb requires Bun ${MIN_BUN_VERSION} or newer.`,
      `Current Bun version: ${versions.bun}.`,
      "Upgrade Bun and try again: https://bun.sh/",
    ].join("\n");
  }
  return getUnsupportedNodeVersionMessage(versions.node);
}

module.exports = {
  MIN_NODE_VERSION,
  MIN_BUN_VERSION,
  getUnsupportedNodeVersionMessage,
  getUnsupportedRuntimeVersionMessage,
  isBunVersionSupported,
  isNodeVersionSupported,
  isRuntimeSupported,
};
