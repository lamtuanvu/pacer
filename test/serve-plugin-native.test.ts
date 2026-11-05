import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pluginNativeRequest } from "../src/serve/plugin-native";
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
