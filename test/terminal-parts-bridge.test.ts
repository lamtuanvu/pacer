import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runStdio } from "../src/api/stdio";
import { startServer } from "../src/serve/http";
import { terminalPartsFor } from "../src/api/terminal-parts-bridge";
import { startReservedShell } from "../src/terminal/workspace";
import type { Ctx } from "../src/types";
import { fakeCtx } from "./helpers";

// The sealed terminal parts route: HTTP `/_internal/terminal-parts` and stdio `_internal.terminal.parts`.

const KEY = "fixture-private-key";
const TOKEN = "s".repeat(64);
const ID = "11111111-1111-4111-8111-111111111111";

function reserved(ctx: Ctx, state = "starting", kind = "shell") {
  mkdirSync(join(ctx.pacerHome, "terminals", ID), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "terminals", ID, "record.json"), JSON.stringify({ id: ID, kind, title: "sh", cwd: ctx.home, createdAt: 1, rev: 1, state }));
}

async function stdio(ctx: Ctx, params: unknown): Promise<string> {
  async function* input() { yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "_internal.terminal.parts", params }); }
  const out: string[] = [];
  await runStdio(ctx, input(), line => out.push(line), { nativeConfigKey: KEY });
  expect(out).toHaveLength(1);
  return out[0]!.trimEnd();
}

test("the HTTP route admits only the internal bearer", async () => {
  const ctx = fakeCtx();
  const server = startServer(() => ctx, { port: 0, pumpMs: 0, internal: { token: TOKEN } });
  const post = async (headers: Record<string, string>) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/_internal/terminal-parts`, { method: "POST", headers: { host: `127.0.0.1:${server.port}`, "content-type": "application/json", ...headers }, body: JSON.stringify({ kind: "terminal.live" }) });
    return { status: response.status, text: await response.text() };
  };
  try {
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: `Bearer ${"x".repeat(64)}` })).status).toBe(401);
    for (const auth of ["cookie", "task", "other"]) {
      expect(await post({ authorization: `Bearer ${TOKEN}`, "x-pacer-auth": auth, "x-pacer-work-grant": "Bearer pwg_fixture" })).toEqual({ status: 403, text: "forbidden\n" });
    }
    expect(await post({ authorization: `Bearer ${TOKEN}`, "x-pacer-auth": "bearer" })).toEqual({ status: 200, text: JSON.stringify({ result: { live: 0 } }) });
  } finally { server.stop(); }
}, 30000);

test("the sealed stdio method answers unknown_op for a missing or wrong key and for a work-grant caller", async () => {
  const ctx = fakeCtx();
  const granted: Ctx = { ...ctx, env: { ...ctx.env, PACER_WORK_GRANT: "pwg_fixture" } };
  for (const [caller, params] of [[ctx, { kind: "terminal.live" }], [ctx, { kind: "terminal.live", key: "wrong" }], [granted, { kind: "terminal.live", key: KEY }]] as const) {
    expect(JSON.parse(await stdio(caller, params)).error.data.code).toBe("unknown_op");
  }
  expect(JSON.parse(await stdio(ctx, { kind: "terminal.live", key: KEY })).result).toEqual({ live: 0 });
});

test("no command, folder or environment crosses the channel", async () => {
  const ctx = fakeCtx();
  reserved(ctx);
  for (const extra of [{ argv: ["/bin/sh", "-c", "touch bad"] }, { cwd: "/" }, { env: { A: "1" } }]) {
    await expect(terminalPartsFor(ctx, { kind: "terminal.start", id: ID, ...extra })).rejects.toMatchObject({ code: "invalid_input" });
  }
  for (const input of [null, {}, { kind: "terminal.exec" }, { kind: "terminal.start" }, { kind: "terminal.stop", id: "../../etc" }]) {
    await expect(terminalPartsFor(ctx, input)).rejects.toMatchObject({ code: "invalid_input" });
  }
});

test("only a reserved shell that is still starting can be launched, in its recorded folder", () => {
  const ctx = fakeCtx();
  const specs: { cwd: string; argv: string[]; env: Record<string, string | undefined>; terminal?: boolean }[] = [];
  const start = (spec: (typeof specs)[number]) => { specs.push(spec); return { pid: 42 }; };
  for (const [state, kind] of [["running", "shell"], ["failed", "shell"], ["starting", "action"]] as const) {
    reserved(ctx, state, kind);
    expect(() => startReservedShell(ctx, ID, { start })).toThrow("Terminal is not waiting to start");
  }
  expect(specs).toEqual([]);
  reserved(ctx);
  const secret: Ctx = { ...ctx, env: { ...ctx.env, PACER_AUTH_TOKEN: "secret", PACER_ROLE: "executor", PACER_WORK_GRANT: "pwg" } };
  expect(startReservedShell(secret, ID, { start })).toEqual({ pid: 42 });
  expect(specs[0]).toMatchObject({ cwd: ctx.home, terminal: true });
  expect(specs[0]!.argv.at(-1)).toBe("-l");
  expect(specs[0]!.env.SHELL).toBe(specs[0]!.argv[0]);
  for (const name of ["PACER_AUTH_TOKEN", "PACER_ROLE", "PACER_WORK_GRANT"]) expect(specs[0]!.env[name]).toBeUndefined();
  expect(existsSync(join(ctx.pacerHome, "terminals", ID, "record.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(ctx.pacerHome, "terminals", ID, "record.json"), "utf8")).state).toBe("starting");
});
