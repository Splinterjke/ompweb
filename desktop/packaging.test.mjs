import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("the desktop app spawns the Bun runtime on the server entry, with no node preload", () => {
  // The Bun server stamps the socket peer at its own HTTP boundary, so the
  // Node-era preload and its postbuild copy step are gone.
  assert.equal(fs.existsSync(path.join(root, "bin", "request-peer-preload.js")), false);
  assert.equal(fs.existsSync(path.join(root, "scripts", "postbuild-static.mjs")), false);
  const app = fs.readFileSync(path.join(root, "server", "app.ts"), "utf8");
  assert.match(app, /server\.requestIP\(request\)\?\.address/);
  assert.match(app, /requestPeerHeaders\(/);
  const main = fs.readFileSync(path.join(root, "desktop", "main.js"), "utf8");
  assert.match(main, /require\("\.\.\/bin\/bun-runtime"\)/);
  assert.match(main, /resolveBunBinary\(pkgDir\)/);
  // Packaged Bun binaries live outside the asar (electron-builder asarUnpack),
  // so the resolved path is remapped before it is exec'd.
  assert.match(main, /bin\.replace\("app\.asar", "app\.asar\.unpacked"\)/);
  const unpacked = packageJson.build.asarUnpack ?? [];
  assert.ok(unpacked.includes("node_modules/bun/**"));
  assert.match(main, /spawn\(bunBin, \[serverEntry, "-p", String\(APP_PORT\), "-H", HOST\]/);
  assert.match(main, /path\.join\(standaloneDir, "server", "main\.ts"\)/);
  assert.doesNotMatch(main, /request-peer-preload/);
  assert.doesNotMatch(main, /ELECTRON_RUN_AS_NODE/);
  // The double-click CLI launcher runs the same Bun entry.
  const desktopBin = fs.readFileSync(path.join(root, "bin", "omp-web-desktop.js"), "utf8");
  assert.match(desktopBin, /spawn\(bunBin, \[path\.join\(pkgDir, "server", "main\.ts"\), "-p", port, "-H", hostname\]/);
  assert.doesNotMatch(desktopBin, /nextBin|next\/dist|request-peer-preload/);
});

test("desktop packaging stages the Bun server tree under Resources/standalone", () => {
  // desktop/main.js runs `bun <Resources>/standalone/server/main.ts` with the
  // standalone dir as cwd: the client build (dist), the server, the Node-side
  // libs, the API route modules and the static public tree must all ship.
  const staged = new Map(packageJson.build.extraResources.map((resource) => [resource.from, resource.to]));
  for (const directory of ["dist", "server", "lib", "app/api", "public"]) {
    assert.equal(staged.get(directory), `standalone/${directory}`, `extraResources must stage ${directory}`);
  }
  // Nothing Next-era may creep back in.
  assert.ok(![...staged.keys()].some((from) => from.startsWith(".next")));
});

test("Windows desktop services stay headless and do not create a detached console", () => {
  const mainJs = fs.readFileSync(path.join(root, "desktop", "main.js"), "utf8");
  assert.match(mainJs, /detached: process\.platform !== "win32"/);
  assert.match(mainJs, /windowsHide: true/);
});

test("desktop server startup cannot churn background processes", () => {
  const mainJs = fs.readFileSync(path.join(root, "desktop", "main.js"), "utf8");
  assert.match(mainJs, /let serverStartPromise = null/);
  assert.match(mainJs, /if \(serverStartPromise\) return serverStartPromise/);
});
