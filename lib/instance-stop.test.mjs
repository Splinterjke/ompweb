import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const { pidOnPort, terminateInstanceProcess, waitForPortRelease } = await import("./instance-stop.ts");

/** Spawn a real TCP listener as a child process and resolve the port it bound. */
function listenChild() {
  const code = "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>console.log(String(s.address().port)));";
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const port = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("listener child did not report a port")), 15000);
    child.stdout.on("data", (chunk) => {
      clearTimeout(timer);
      resolve(Number(chunk.toString().trim()));
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("listener child exited before reporting a port")); });
  });
  return { child, port };
}

// The shipped stop-instance action answered success while doing nothing on
// Windows (its pid lookup used lsof, which Windows does not ship), so the
// diagnostics panel toasted "instance stopped" with both instances still
// serving behind their ports. This drives the real listener lookup, the real
// termination, and the real port.
test("pidOnPort finds a live listener and terminateInstanceProcess frees its port", async () => {
  const { child, port: portPromise } = listenChild();
  const port = await portPromise;
  assert.ok(Number.isInteger(port) && port > 0, "the child reported its bound port");

  assert.equal(pidOnPort(port), child.pid, "the listener is found by port lookup");

  await terminateInstanceProcess(child.pid);
  assert.equal(await waitForPortRelease(port, 8000), true, "the port stopped answering after termination");
  await new Promise((resolve) => child.once("exit", resolve));

  assert.equal(pidOnPort(port), null, "no listener remains on the freed port");
});
