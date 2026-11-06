import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pluginNativeRequest } from "../src/serve/plugin-native";
import { isExactHttpHost, isExactIssuedPath, sealCallAuthority } from "../src/plugins/native-call-authority";
import { fakeCtx, tmpDir } from "./helpers";

function ctxWithSocket(socket: string | undefined) {
  const home = tmpDir();
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  writeFileSync(join(pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n", { mode: 0o600 });
  return fakeCtx({
    home,
    pacerHome,
    env: socket ? { PACER_HOST_SOCKET: socket } : {},
  });
}

test("private call is retired when PACER_HOST_SOCKET is set", async () => {
  const out = await pluginNativeRequest(ctxWithSocket("/tmp/pacer-host.sock"), {
    kind: "call",
    id: "fx-ui",
    method: "diagnostic.ping",
    params: {},
  });
  expect(out.error?.code).toBe("plugin_unavailable");
  expect(String(out.error?.message)).toMatch(/retired|native process owner/i);
});

test("private prepare still works when PACER_HOST_SOCKET is set", async () => {
  const out = await pluginNativeRequest(ctxWithSocket("/tmp/pacer-host.sock"), {
    kind: "prepare",
    op: "plugin.list",
    params: {},
  });
  expect(out.error).toBeUndefined();
  expect(out.value).toEqual({});
});

test("sealCallAuthority auto-issues exact fs.read paths and http hosts", () => {
  const path = "/tmp/pacer-p4d7-fixture.txt";
  expect(isExactIssuedPath(path)).toBe(true);
  expect(isExactIssuedPath("$HOME/**")).toBe(false);
  expect(isExactHttpHost("127.0.0.1")).toBe(true);
  expect(isExactHttpHost("*.example.com")).toBe(false);
  const sealed = sealCallAuthority(
    fakeCtx(),
    {
      id: "fx-auth",
      version: "1.0.0",
      publisher: "fixture",
      host: ">=1.10.0",
      capabilities: [
        { name: "fs.read", scopes: [path, "$HOME/**"] },
        { name: "net.http", scopes: ["127.0.0.1", "*.bad"] },
        { name: "log" },
      ],
      contributes: { diagnostic: {} },
    } as any,
    ["fs.read", "net.http", "log"],
  );
  expect(sealed.ttlMs).toBe(30_000);
  expect(sealed.resources.reads).toEqual([{ path, kind: "file" }]);
  expect(sealed.resources.http).toEqual({ hosts: ["127.0.0.1"] });
  expect(sealed.grants).toEqual(["fs.read", "net.http", "log"]);
});

test("sealCallAuthority seals observation bootstrap for policy admission methods", () => {
  const ctx = fakeCtx();
  const sealed = sealCallAuthority(
    ctx,
    {
      id: "fx-policy",
      version: "1.0.0",
      publisher: "fixture",
      host: ">=1.10.0",
      capabilities: [{ name: "tasks.read" }, { name: "events.subscribe" }],
      contributes: { policy: {} },
    } as any,
    ["tasks.read", "events.subscribe"],
    { method: "policy.before" },
  );
  expect(sealed.observation?.bootstrap).toBe(true);
  expect(sealed.observation?.callToken).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  expect(sealed.observation?.readContext.home).toBe(ctx.home);
  expect(sealCallAuthority(
    ctx,
    { id: "fx", version: "1.0.0", publisher: "f", host: ">=1.10.0", capabilities: [{ name: "log" }], contributes: {} } as any,
    ["log"],
    { method: "policy.before" },
  ).observation).toBeUndefined();
});

test("sealCallAuthority validates host operation resources when hosts is granted", () => {
  const ctx = fakeCtx();
  const host = {
    alias: "box",
    hostFingerprint: "host-one",
    script: "CHECK_REPO",
    args: ["~/repo"],
    timeoutMs: 1000,
    maxBytes: 1024,
  };
  const sealed = sealCallAuthority(
    ctx,
    { id: "fx", version: "1.0.0", publisher: "f", host: ">=1.10.0", capabilities: [{ name: "hosts" }], contributes: {} } as any,
    ["hosts"],
    { resources: { reads: [], commands: [], stores: [], hosts: [host] } },
  );
  expect(sealed.resources.hosts).toEqual([host]);
  expect(sealed.hostSnapshots).toBeUndefined();
  expect(() => sealCallAuthority(
    ctx,
    { id: "fx", version: "1.0.0", publisher: "f", host: ">=1.10.0", capabilities: [{ name: "hosts" }], contributes: {} } as any,
    ["hosts"],
    { resources: { reads: [], commands: [], stores: [], hosts: [{ ...host, script: "bad" }] } },
  )).toThrow(/host script/);
});

test("sealCallAuthority refuses write resources in this slice", () => {
  expect(() => sealCallAuthority(
    fakeCtx(),
    { id: "fx", version: "1.0.0", publisher: "f", host: ">=1.10.0", capabilities: [{ name: "fs.write" }], contributes: {} } as any,
    ["fs.write"],
    { resources: { reads: [], commands: [], stores: [], writes: [{ path: "/tmp/x", kind: "file", operations: ["write"] }] } },
  )).toThrow(/write resources/);
});

test("private call_authority rejects unknown plugins under PACER_HOST_SOCKET", async () => {
  const out = await pluginNativeRequest(ctxWithSocket("/tmp/pacer-host.sock"), {
    kind: "call_authority",
    id: "missing-plugin",
    method: "diagnostic.ping",
  });
  expect(out.error?.code).toBe("unknown_plugin");
});
