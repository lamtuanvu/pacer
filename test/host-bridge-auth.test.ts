import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { callNativeOwner, HOST_SOCKET_KEY_ENV, takeOwnerKey, type NativeOwnerCall } from "../src/plugins/host-bridge";
import { authed, useOwnerKey } from "./fixtures/owner-auth";
import { tmpDir } from "./helpers";

// Core's side of the owner credential (#918): taken out of the environment at
// startup, proven on every connection, never sent to an owner that cannot prove it.

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise(done => server.close(done));
});

async function listen(handler: (socket: Socket) => void): Promise<{ path: string; connections: () => number }> {
  const run = join(tmpDir(), "run");
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const path = join(run, "host.sock");
  let connections = 0;
  const server = createServer(socket => { connections++; handler(socket); });
  servers.push(server);
  await new Promise<void>(done => server.listen(path, done));
  return { path, connections: () => connections };
}

const call: NativeOwnerCall = {
  id: "fx", method: "diagnostic.ping", params: {}, spawn: {}, authority: {},
  scopeRoots: { home: "/h", pacerHome: "/h/.pacer", accountHome: null },
};

/** Every line the stand-in receives, until Core closes. */
function record(socket: Socket, seen: string[], reply?: (line: string) => string | undefined) {
  let text = "";
  socket.on("error", () => {});
  socket.on("data", data => {
    text += data.toString("utf8");
    for (let cut = text.indexOf("\n"); cut >= 0; cut = text.indexOf("\n")) {
      const line = text.slice(0, cut);
      text = text.slice(cut + 1);
      seen.push(line);
      const answer = reply?.(line);
      if (answer !== undefined) socket.write(answer + "\n");
    }
  });
}

test("Core takes the credential out of its environment and the process environment", () => {
  const env: Record<string, string | undefined> = { [HOST_SOCKET_KEY_ENV]: "ab".repeat(32), PATH: "/bin" };
  process.env[HOST_SOCKET_KEY_ENV] = "ab".repeat(32);
  takeOwnerKey(env);
  expect(env).not.toHaveProperty(HOST_SOCKET_KEY_ENV);
  expect(process.env[HOST_SOCKET_KEY_ENV]).toBeUndefined();
  expect(env.PATH).toBe("/bin");
});

test("without a credential Core never dials the owner", async () => {
  takeOwnerKey({ [HOST_SOCKET_KEY_ENV]: "not-a-key" });
  const owner = await listen(socket => socket.destroy());
  await expect(callNativeOwner(owner.path, call)).rejects.toMatchObject({
    code: "plugin_unavailable", message: "native process owner credential is missing", hint: "Restart the pacer service.",
  });
  expect(owner.connections()).toBe(0);
});

test("Core sends no proof and no call to an owner that cannot prove the credential", async () => {
  useOwnerKey();
  const seen: string[] = [];
  let closed!: () => void;
  const hungUp = new Promise<void>(done => { closed = done; });
  const impostor = await listen(socket => {
    socket.on("close", () => closed());
    record(socket, seen, line => {
      const challenge = JSON.parse(line);
      return JSON.stringify({ jsonrpc: "2.0", id: challenge.id, result: { nonce: "11".repeat(32), proof: "22".repeat(32) } });
    });
  });
  await expect(callNativeOwner(impostor.path, call)).rejects.toMatchObject({
    code: "plugin_unavailable", message: expect.stringContaining("failed authentication"),
  });
  await hungUp;
  expect(seen.length).toBe(1);
  expect(JSON.parse(seen[0]!)).toMatchObject({ id: "auth", method: "_host.auth", params: { nonce: expect.stringMatching(/^[0-9a-f]{64}$/) } });
});

test("a call proven to the owner reaches it; a refused caller learns to reconnect", async () => {
  useOwnerKey();
  const seen: string[] = [];
  const owner = await listen(authed(socket => record(socket, seen, line => {
    const frame = JSON.parse(line);
    return JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { value: { ok: true }, hello: null, logs: [] } });
  })));
  expect(await callNativeOwner(owner.path, call)).toMatchObject({ value: { ok: true } });
  expect(JSON.parse(seen[0]!)).toMatchObject({ method: "_host.plugin.call", params: { id: "fx" } });
  expect(seen.join("\n")).not.toContain("_host.auth");

  // A rotated owner (a restarted service) refuses the old credential.
  const restarted = await listen(socket => record(socket, [], line => {
    const frame = JSON.parse(line);
    return JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32001, message: "unauthorized" } });
  }));
  await expect(callNativeOwner(restarted.path, call)).rejects.toMatchObject({
    code: "plugin_unavailable", message: expect.stringContaining("refused this caller"), hint: expect.stringContaining("Reconnect"),
  });
});
