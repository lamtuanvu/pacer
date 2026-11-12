import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { hostSocketCheck } from "../src/install/host-socket-check";
import { fakeCtx } from "./helpers";

// Socket paths must stay under the 104-byte sun_path limit, so homes live in /tmp.
const homes: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home() {
  const pacerHome = mkdtempSync("/tmp/pdh.");
  homes.push(pacerHome);
  mkdirSync(join(pacerHome, "run"), { mode: 0o700 });
  return { ctx: fakeCtx({ pacerHome }), socket: join(pacerHome, "run", "host.sock"), sidecar: join(pacerHome, "run", "host.sock.pid") };
}

async function listen(path: string) {
  const server = createServer(socket => socket.destroy());
  servers.push(server);
  await new Promise<void>(resolve => server.listen(path, resolve));
}

test("no host socket means no check", async () => {
  expect(await hostSocketCheck(home().ctx)).toBeNull();
});

test("a live host socket names its owner pid and the wait-or-stop remedy", async () => {
  const h = home();
  await listen(h.socket);
  writeFileSync(h.sidecar, "4242\n", { mode: 0o600 });
  const check = await hostSocketCheck(h.ctx);
  expect(check).toEqual({ name: "Plugin host socket", level: "info",
    detail: `${h.socket} is live (owner pid 4242); another pacer serve on this home exits 3 until it stops. Stop the owner (pacer service stop) or wait for it to exit.` });
});

test("a live host socket without a readable sidecar reports an unknown owner", async () => {
  const h = home();
  await listen(h.socket);
  writeFileSync(h.sidecar, "not a pid\n");
  expect((await hostSocketCheck(h.ctx))?.detail).toContain("(owner pid unknown)");
});

test("a host socket left by a killed owner is stale and replaced on the next start", async () => {
  const h = home();
  const owner = Bun.spawn([process.execPath, "-e", `require("node:net").createServer().listen(${JSON.stringify(h.socket)}, () => console.log("up"))`],
    { stdout: "pipe" });
  const reader = owner.stdout.getReader();
  await reader.read();
  owner.kill("SIGKILL");
  await owner.exited;
  expect(existsSync(h.socket)).toBe(true);
  expect(await hostSocketCheck(h.ctx)).toEqual({ name: "Plugin host socket", level: "info",
    detail: `${h.socket} is stale; the next pacer serve replaces it` });
});

test("a non-socket at the host socket path is a warning serve will not clear", async () => {
  const h = home();
  writeFileSync(h.socket, "");
  const check = await hostSocketCheck(h.ctx);
  expect(check?.level).toBe("warn");
  expect(check?.detail).toContain("is not a socket");
});
