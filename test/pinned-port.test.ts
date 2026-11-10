import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closedPort, pinnedEnv, REAL_SERVICE_PORT, spawnPinned } from "./pinned-port";

const SPAWNING = ["native-dispatch.test.ts", "native-setup-parity.test.ts", "native-setup-doctor-parity.test.ts"];

test("spawned test processes refuse an environment that can reach the real service", () => {
  expect(() => spawnPinned(["/usr/bin/true"], { env: {} })).toThrow(/PACER_PORT/);
  expect(() => spawnPinned(["/usr/bin/true"], { env: { PACER_PORT: String(REAL_SERVICE_PORT) } })).toThrow(/PACER_PORT/);
  expect(() => spawnPinned(["/usr/bin/true"], { env: { PACER_PORT: "" } })).toThrow(/PACER_PORT/);
  expect(() => pinnedEnv({}, REAL_SERVICE_PORT)).toThrow(/PACER_PORT/);
  const port = closedPort();
  expect(port).not.toBe(REAL_SERVICE_PORT);
  expect(pinnedEnv({ HOME: "/h" }, port)).toEqual({ HOME: "/h", PACER_PORT: String(port) });
  expect(pinnedEnv({ PACER_PORT: "5" }).PACER_PORT).toBe("5");
  expect(Number(pinnedEnv({}).PACER_PORT)).not.toBe(REAL_SERVICE_PORT);
});

test("native front-door tests spawn only through spawnPinned or with a pinned env", () => {
  for (const name of SPAWNING) {
    const source = readFileSync(join(import.meta.dir, name), "utf8");
    expect(source, name).toContain("spawnPinned(");
    expect(source, name).not.toMatch(/Bun\.spawn(Sync)?\(|\bspawn(Sync)?\(\[/);
    for (const call of source.match(/execFileSync\([^;]*/g) ?? []) expect(call, name).toMatch(/\benv\b/);
  }
});
