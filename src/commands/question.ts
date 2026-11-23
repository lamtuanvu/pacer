// `pacer question`: escalate / get / list / convert structured run questions.
import { connectClient } from "../api/client";
import { assertCallerCanInvoke } from "../api/caller-policy";
import { callOp, type OpDeps } from "../api/ops";
import { commandArgs } from "./accounts";
import type { Command, Result } from "./types";
import type { Ctx } from "../types";

const USAGE =
  "usage: pacer question escalate <id> --suggested <text> --reason <text> [--expect-rev N] | get <id> | list [--run <id>] [--status open|answered|withdrawn] | convert <task-id> [--json]";

async function call(ctx: Ctx, op: string, params: Record<string, unknown>, deps: OpDeps = {}): Promise<unknown> {
  assertCallerCanInvoke(ctx, op, params);
  const client = await connectClient(ctx, { protocol: 3, opDeps: deps });
  try {
    return client.kind === "inprocess" ? await callOp(ctx, op, params, deps) : await client.call(op, params);
  } finally {
    client.close();
  }
}

export async function questionCmd(args: string[], ctx: Ctx, deps: OpDeps = {}): Promise<Result> {
  const [sub, ...rest] = args;
  try {
    if (sub === "escalate") {
      const { pos, flags } = commandArgs(rest, ["suggested", "reason", "expect-rev"], ["json"]);
      if (pos.length !== 1 || !flags.suggested || !flags.reason) throw Error(USAGE);
      let expectRev = flags["expect-rev"] !== undefined ? Number(flags["expect-rev"]) : undefined;
      if (expectRev === undefined || Number.isNaN(expectRev)) {
        const current = await call(ctx, "question.get", { id: pos[0] }, deps) as { rev: number };
        expectRev = current.rev;
      }
      const result = await call(ctx, "question.escalate", {
        id: pos[0],
        suggested: String(flags.suggested),
        reason: String(flags.reason),
        expect_rev: expectRev,
      }, deps);
      return { code: 0, out: JSON.stringify(result, null, flags.json ? 2 : undefined), err: "" };
    }
    if (sub === "get") {
      const { pos, flags } = commandArgs(rest, [], ["json"]);
      if (pos.length !== 1) throw Error(USAGE);
      const result = await call(ctx, "question.get", { id: pos[0] }, deps);
      return { code: 0, out: JSON.stringify(result, null, flags.json ? 2 : undefined), err: "" };
    }
    if (sub === "list") {
      const { pos, flags } = commandArgs(rest, ["run", "status"], ["json"]);
      if (pos.length) throw Error(USAGE);
      const result = await call(ctx, "question.list", {
        ...(flags.run ? { run: String(flags.run) } : {}),
        ...(flags.status ? { status: String(flags.status) } : {}),
      }, deps);
      return { code: 0, out: JSON.stringify(result, null, flags.json ? 2 : undefined), err: "" };
    }
    if (sub === "convert") {
      const { pos, flags } = commandArgs(rest, [], ["json"]);
      if (pos.length !== 1) throw Error(USAGE);
      const result = await call(ctx, "question.convert_prompt", { id: pos[0] }, deps);
      return { code: 0, out: JSON.stringify(result, null, flags.json ? 2 : undefined), err: "" };
    }
    throw Error(USAGE);
  } catch (e) {
    return { code: 2, out: "", err: e instanceof Error ? e.message : String(e) };
  }
}

export const COMMANDS: Command[] = [
  { name: "question", usage: USAGE, run: (args, ctx) => questionCmd(args, ctx) },
];
