import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { io } from "../src/install/stdin";
import { main } from "../src/cli";
import { fakeCtx } from "./helpers";

const STRATEGY = "planner: claude-code\nproviders:\n  claude-code: {}\n  local: { via: opencode, model: lmstudio/q, usage: unmetered }\n";

async function withStrategy() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), STRATEGY);
  return ctx;
}

test("status rejects --json --line instead of choosing a mode", async () => {
  const r = await main(["status", "--json", "--line"], await withStrategy());
  expect(r.code).toBe(2);
  expect(r.out).toBe("");
  expect(r.err).toContain("only one of");
  expect(r.err).toContain("usage: pacer status [--line | --json | --hook <planner>]");
});

test("status --hook needs an explicit planner", async () => {
  const r = await main(["status", "--hook"], await withStrategy());
  expect(r.code).toBe(2);
  expect(r.out).toBe("");
  expect(r.err).toContain("needs a planner");
});

test("status --hook rejects an unknown planner", async () => {
  const r = await main(["status", "--hook", "gemini"], await withStrategy());
  expect(r.code).toBe(2);
  expect(r.out).toBe("");
  expect(r.err).toContain("needs a planner");
});

test("status --hook --json reports conflicting modes before a missing planner", async () => {
  const r = await main(["status", "--hook", "--json"], await withStrategy());
  expect(r.code).toBe(2);
  expect(r.out).toBe("");
  expect(r.err).toContain("only one of");
});

test("status rejects unknown flags", async () => {
  const r = await main(["status", "--jsn"], await withStrategy());
  expect(r.code).toBe(2);
  expect(r.out).toBe("");
  expect(r.err).toContain('unknown argument "--jsn"');
});

test("status reports unknown arguments before conflicting modes", async () => {
  const r = await main(["status", "--json", "--line", "--jsn", "extra"], await withStrategy());
  expect(r.code).toBe(2);
  expect(r.out).toBe("");
  expect(r.err).toContain('unknown argument "--jsn", "extra"');
  expect(r.err).not.toContain("only one of");
});

test("status rejects repeated mode flags", async () => {
  const r = await main(["status", "--line", "--line"], await withStrategy());
  expect(r.code).toBe(2);
  expect(r.err).toContain("only one of");
});

test("status --hook configured planner renders subscription budget context", async () => {
  const r = await main(["status", "--hook", "claude-code"], await withStrategy());
  expect(r.code).toBe(0);
  expect(r.out).toContain("Subscription budget status (pacer)");
  expect(r.err).toBe("");
});

test("status --line renders the budget line", async () => {
  const ctx=await withStrategy();
  await Bun.write(join(ctx.pacerHome,"link/latest.json"),JSON.stringify({v:1,seq:0,at:ctx.now,budget:null,mode:null,tasks:[],alerts:[],console:null}));
  const r = await main(["status", "--line"], ctx);
  expect(r.code).toBe(0);
  expect(r.out).toContain("◆ Budget");
  expect(r.err).toBe("");
});

test("status --line exits zero without a strategy", async () => {
  const r = await main(["status", "--line"], fakeCtx());
  expect(r.code).toBe(0);
  expect(r.out).toBe("pacer not running · pacer serve");
  expect(r.err).toBe("");
});

test("status --hook claude-code exits zero without a strategy", async () => {
  const r = await main(["status", "--hook", "claude-code"], fakeCtx());
  expect(r).toEqual({ code: 0, out: "{}", err: "" });
});

test("status validates hook arguments before fail-open strategy handling", async () => {
  const r = await main(["status", "--hook"], fakeCtx());
  expect(r.code).toBe(2);
  expect(r.out).toBe("");
  expect(r.err).toContain("needs a planner");
});

test("status --hook on a TTY renders without reading stdin", async () => {
  const ctx = await withStrategy();
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const read = io.readStdin;
  let reads = 0;
  try {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    io.readStdin = async () => { reads++; return ""; };
    const result = await main(["status", "--hook", "claude-code"], ctx);
    expect(result.out).toContain("Subscription budget status (pacer)");
    expect(reads).toBe(0);
  } finally {
    io.readStdin = read;
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
});
