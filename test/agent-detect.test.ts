import { expect, spyOn, test } from "bun:test";
import { detectAgents, DETECT_DEADLINE_MS } from "../src/install/detection";
import { callOp } from "../src/api/ops";
import { CoreError } from "../src/core/errors";
import { PluginRegistry } from "../src/plugins/registry";
import { fakeCtx } from "./install-plugin-fixtures";
import {withVersionFixtures} from "./planner-detect-fixtures";
import { listJobs } from "../src/jobs/registry";
import { join } from "node:path";
import { readdirSync } from "node:fs";

test("detects installed CLIs and versions using only --version with a five second timeout", async () => {
  const calls: string[][] = [];
  const ctx = withVersionFixtures(fakeCtx({ which: bin => bin === "opencode" ? null : `/bin/${bin}`, run: async (argv, timeout, options) => {
    calls.push(argv); expect(timeout).toBe(5000); expect(options?.env).toEqual({});
    return { code: 0, stdout: argv[0] === "/bin/codex" ? "codex-cli 0.52.0\n" : "v2.4", stderr: "" };
  } }));
  const result = await detectAgents(ctx);
  expect(result.find(a => a.agent === "codex")).toMatchObject({ found: true, version: "0.52.0", path: ctx.which("codex") });
  expect(result.find(a => a.agent === "cursor")).toMatchObject({ found: true, version: "2.4", path: ctx.which("cursor-agent") });
  expect(result.find(a => a.agent === "opencode")).toMatchObject({ found: false, version: null, path: null, install_hint: "brew install opencode" });
  expect(calls.every(argv => argv.length === 2 && argv[1] === "--version")).toBe(true);
  expect(calls).toHaveLength(3);
});
test("results are cached for one hour and refreshed afterwards", async () => {
  let calls = 0;
  const ctx = withVersionFixtures(fakeCtx({ which: bin => bin === "codex" ? "/bin/codex" : null, run: async () => { calls++; return { code: 0, stdout: `codex ${calls}.0.0`, stderr: "" }; } }));
  const first = await detectAgents(ctx);
  expect(await callOp({ ...ctx, now: ctx.now + 3599 }, "agent.detect", {})).toEqual(first);
  expect(calls).toBe(1);
  expect((await detectAgents({ ...ctx, now: ctx.now + 3600 })).find(a => a.agent === "codex")?.version).toBe("2.0.0");
  expect(calls).toBe(2);
});
test("remote detection is unavailable without probing or starting jobs", async () => {
  const ctx = fakeCtx({ which: () => { throw Error("no local probe"); }, run: async () => { throw Error("no remote probe"); } });
  const rows = await callOp(ctx, "agent.detect", { host: "dev" }) as Awaited<ReturnType<typeof detectAgents>>;
  expect(rows).toHaveLength(4);
  expect(rows.every(row => !row.found && row.version === null && row.path === null)).toBe(true);
  expect(listJobs(ctx)).toEqual([]);
});
test("failed or unparseable version commands keep found path and null version", async () => {
  for (const run of [async () => ({ code: 1, stdout: "error 9.9.9", stderr: "" }), async () => ({ code: 0, stdout: "development", stderr: "" }), async () => { throw Error("timeout"); }]) {
    const rows = await detectAgents(withVersionFixtures(fakeCtx({ run })));
    expect(rows.every(row => row.found && row.version === null)).toBe(true);
  }
});

test("planner.detect calls use the explicit 20s deadline", async () => {
  const ctx = withVersionFixtures(fakeCtx({ which: bin => bin === "codex" ? "/bin/codex" : null, run: async () => ({ code: 0, stdout: "codex 1.0.0", stderr: "" }) }));
  const original = PluginRegistry.prototype.call;
  const seen: number[] = [];
  const spy = spyOn(PluginRegistry.prototype, "call").mockImplementation(async function (this: any, ...args: any[]) {
    const options = args[4];
    if (args[2] === "planner.detect") seen.push(options?.deadlineMs);
    return original.apply(this, args as any);
  } as any);
  try {
    await detectAgents(ctx);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((value) => value === DETECT_DEADLINE_MS)).toBe(true);
    expect(DETECT_DEADLINE_MS).toBe(20000);
  } finally {
    spy.mockRestore();
  }
});

test("single-agent detection probes only that agent and does not write the cache", async () => {
  const ctx = withVersionFixtures(fakeCtx({ which: bin => bin === "codex" ? "/bin/codex" : null, run: async () => ({ code: 0, stdout: "codex 1.0.0", stderr: "" }) }));
  const result = await detectAgents(ctx, { agent: "codex" });
  expect(result).toHaveLength(1);
  expect(result[0].agent).toBe("codex");
  const cacheDir = join(ctx.pacerHome, "cache");
  let files: string[] = [];
  try { files = readdirSync(cacheDir).filter((name) => name.startsWith("agent-detect-")); } catch {}
  expect(files).toHaveLength(0);
});

test("single-agent detection answers from a fresh full cache without probing", async () => {
  let calls = 0;
  const ctx = withVersionFixtures(fakeCtx({ which: bin => bin === "codex" ? "/bin/codex" : null, run: async () => { calls++; return { code: 0, stdout: "codex 1.0.0", stderr: "" }; } }));
  await detectAgents(ctx);
  const before = calls;
  const result = await detectAgents(ctx, { agent: "codex" });
  expect(calls).toBe(before);
  expect(result).toHaveLength(4);
});

test("a plugin_timeout names the agent being detected", async () => {
  const ctx = withVersionFixtures(fakeCtx({ which: bin => bin === "codex" ? "/bin/codex" : null, run: async () => ({ code: 0, stdout: "codex 1.0.0", stderr: "" }) }));
  const original = PluginRegistry.prototype.call;
  const spy = spyOn(PluginRegistry.prototype, "call").mockImplementation(async function (this: any, ...args: any[]) {
    if (args[2] === "planner.detect") throw new CoreError("plugin_timeout", "plugin timed out");
    return original.apply(this, args as any);
  } as any);
  try {
    await expect(detectAgents(ctx, { agent: "codex" })).rejects.toMatchObject({
      code: "plugin_timeout",
      message: "Detecting Codex timed out",
    });
  } finally {
    spy.mockRestore();
  }
});
