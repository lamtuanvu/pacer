import { expect, test } from "bun:test";
import { detectAgents } from "../src/install/detection";
import { callOp } from "../src/api/ops";
import { fakeCtx } from "./helpers";
import { listJobs } from "../src/jobs/registry";

test("detects installed CLIs and versions using only --version with a five second timeout", async () => {
  const calls: string[][] = [];
  const ctx = fakeCtx({ which: bin => bin === "opencode" || bin === "cursor-agent" ? null : `/bin/${bin}`, run: async (argv, timeout, options) => {
    calls.push(argv); expect(timeout).toBe(5000); expect(options?.env).toEqual({});
    return { code: 0, stdout: argv[0] === "/bin/codex" ? "codex-cli 0.52.0\n" : "v2.4", stderr: "" };
  } });
  const result = await detectAgents(ctx);
  expect(result.find(a => a.agent === "codex")).toMatchObject({ found: true, version: "0.52.0", path: "/bin/codex" });
  expect(result.find(a => a.agent === "cursor")).toMatchObject({ found: true, version: "2.4", path: "/bin/cursor" });
  expect(result.find(a => a.agent === "opencode")).toMatchObject({ found: false, version: null, path: null, install_hint: "brew install opencode" });
  expect(calls.every(argv => argv.length === 2 && argv[1] === "--version")).toBe(true);
  expect(calls).toHaveLength(3);
});
test("results are cached for one hour and refreshed afterwards", async () => {
  let calls = 0;
  const ctx = fakeCtx({ which: bin => bin === "codex" ? "/bin/codex" : null, run: async () => { calls++; return { code: 0, stdout: `codex ${calls}.0.0`, stderr: "" }; } });
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
    const rows = await detectAgents(fakeCtx({ run }));
    expect(rows.every(row => row.found && row.version === null)).toBe(true);
  }
});
