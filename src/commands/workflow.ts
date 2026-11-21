// `pacer workflow`: install, check and list workflow files (plan Task 9). Every
// command calls its Task 8 operation through the shared client, prints the op
// result unchanged with --json, and refuses executor sessions the way the op
// layer does (assertCallerCanInvoke).
import { readFileSync } from "node:fs";
import { connectClient } from "../api/client";
import { assertCallerCanInvoke } from "../api/caller-policy";
import { callOp, type OpDeps } from "../api/ops";
import { commandArgs } from "./accounts";
import type { Command, Result } from "./types";
import type { Ctx } from "../types";

const USAGE = "usage: pacer workflow validate <file> | add <file> | list [--json]";

async function call(ctx: Ctx, op: string, params: Record<string, unknown>, deps: OpDeps): Promise<unknown> {
  assertCallerCanInvoke(ctx, op, params);
  const client = await connectClient(ctx, { protocol: 3, opDeps: deps });
  try {
    return client.kind === "inprocess" ? await callOp(ctx, op, params, deps) : await client.call(op, params);
  } finally { client.close(); }
}

function readSource(file: string | undefined): string {
  if (!file) throw Error(USAGE);
  try { return readFileSync(file, "utf8"); }
  catch { throw Error(`cannot read workflow file: ${file}`); }
}

export async function workflowCmd(args: string[], ctx: Ctx, deps: OpDeps = {}): Promise<Result> {
  const [sub, ...rest] = args;
  try {
    const { pos, flags } = commandArgs(rest, [], ["json"]);
    const json = flags.json === true;
    if (sub === "validate" || sub === "add") {
      const source = readSource(pos[0]);
      const op = sub === "validate" ? "workflow.validate" : "workflow.add";
      const result = await call(ctx, op, { source }, deps) as { ok?: boolean; errors?: { path: string; message: string }[]; id?: string; version?: number; created?: boolean };
      if (json) return { code: 0, out: JSON.stringify(result, null, 2), err: "" };
      if (sub === "validate") {
        if (!result.ok) return { code: 1, out: "", err: result.errors!.map(e => `${e.path}: ${e.message}`).join("\n") };
        return { code: 0, out: "ok", err: "" };
      }
      return { code: 0, out: `${result.id}@${result.version} ${result.created ? "installed" : "already installed"}`, err: "" };
    }
    if (sub === "list") {
      if (pos.length) throw Error(USAGE);
      const defs = await call(ctx, "workflow.list", {}, deps) as { id: string; version: number; title?: string }[];
      if (json) return { code: 0, out: JSON.stringify(defs, null, 2), err: "" };
      return { code: 0, out: defs.map(d => `${d.id}@${d.version}${d.title ? `  ${d.title}` : ""}`).join("\n"), err: "" };
    }
    throw Error(USAGE);
  } catch (e) { return { code: 2, out: "", err: `pacer: ${e instanceof Error ? e.message : String(e)}` }; }
}

export const COMMANDS: Command[] = [
  { name: "workflow", usage: "workflow validate|add <file> | list    check, install and list workflow files", run: (args, ctx) => workflowCmd(args, ctx) },
];
