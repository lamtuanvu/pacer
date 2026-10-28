import { callOp } from "../api/ops";
import { spawnRunner } from "../tasks/api";
import type { Ctx } from "../types";
import { commandArgs } from "./accounts";
import type { Command, Result } from "./types";

const TASK = /^t-\d{8}-\d{6}-[0-9a-f]{4}$/;
const target = (s: string) => TASK.test(s) ? `task:${s}` : s;
const MSG_USAGE = "usage: pacer msg send|inbox|log|read|confirm|close|policy";

// In-process on purpose: the sender identity comes from this process's environment,
// which a service handling an HTTP call would not see. State is shared through the task store.
const call = (ctx: Ctx, op: string, params: Record<string, unknown>): Promise<any> => Promise.resolve(callOp(ctx, op, params, { spawnRunner }));
const show = (messages: Array<{ id: string; from: string; to: string; kind: string; body: string }>) =>
  messages.map(m => `${m.id}  ${m.kind}  ${m.from} -> ${m.to}\n${m.body}\n`).join("\n") || "(no messages)";
const out = (json: boolean, value: unknown, text: string): Result => ({ code: 0, out: json ? JSON.stringify(value, null, 2) : text, err: "" });
const fail = (e: unknown): Result => ({ code: 2, out: "", err: `pacer: ${e instanceof Error ? e.message : String(e)}` });

async function msgCmd(args: string[], ctx: Ctx): Promise<Result> {
  try {
    const sub = args[0];
    const { pos, flags } = commandArgs(args.slice(1), ["answer", "request-id", "task", "from", "to", "kind", "timeout"], ["question", "wait", "json", "all", "check"]);
    const json = !!flags.json;
    const f = (k: string) => flags[k] as string | undefined;
    switch (sub) {
      case "send": {
        if (f("to") && pos.length === 1) pos.unshift(f("to")!);
        if (pos.length !== 2) return { code: 2, out: "", err: "usage: pacer msg send <task|participant> | --to <participant> \"<text>\" [--question] [--answer <id>] [--request-id <k>] [--wait] [--json]" };
        const r = await call(ctx, "msg.send", { to: target(pos[0]!), body: pos[1], kind: f("answer") ? "answer" : flags.question ? "question" : "message",
          ...(f("answer") ? { reply_to: f("answer") } : {}), ...(f("request-id") ? { request_id: f("request-id") } : {}) });
        if (!flags.wait) return out(json, r, `sent ${r.message.id} (${r.delivery})`);
        const w = await call(ctx, "msg.wait", { reply_to: r.message.id, timeout_s: Number(f("timeout") ?? 600) });
        return out(json, { sent: r, reply: w }, show(w.messages));
      }
      case "inbox": {
        const r = flags.wait ? await call(ctx, "msg.wait", { timeout_s: Number(f("timeout") ?? 600) }) : await call(ctx, "msg.inbox", { unread_only: !flags.all });
        return out(json, r, `inbox for ${r.participant}\n\n${show(r.messages)}`);
      }
      case "log": { const r = await call(ctx, "msg.log", { task: pos[0] }); return out(json, r, show(r.messages)); }
      case "read": { const r = await call(ctx, "msg.read", { ids: pos }); return out(json, r, `marked ${r.read} read`); }
      case "confirm": { const r = await call(ctx, "msg.confirm", { id: pos[0] }); return out(json, r, `released ${r.message.id} (${r.delivery})`); }
      case "close": { const r = await call(ctx, "msg.close", { task: pos[0] }); return out(json, r, `closed ${r.task}`); }
      case "policy": {
        const check = flags.check ? { from: f("from"), to: f("to") && target(f("to")!), kind: f("kind") ?? "message" } : undefined;
        const r = await call(ctx, "msg.policy", { ...(f("task") ? { task: f("task") } : {}), ...(check ? { check } : {}) });
        return out(json, r, JSON.stringify(r, null, 2));
      }
      default: return { code: 2, out: "", err: MSG_USAGE };
    }
  } catch (e) { return fail(e); }
}

async function treeCmd(args: string[], ctx: Ctx): Promise<Result> {
  try {
    const { pos, flags } = commandArgs(args, [], ["json"]);
    if (pos.length !== 1) return { code: 2, out: "", err: "usage: pacer tree <task> [--json]" };
    const r = await call(ctx, "tree.status", { task: pos[0] });
    return out(!!flags.json, r, r.nodes.map((n: any) => `${n.id}  ${n.state}${n.closed ? " (closed)" : ""}  pending ${n.pending}`).join("\n"));
  } catch (e) { return fail(e); }
}

export const COMMANDS: Command[] = [
  { name: "msg", usage: "msg send|inbox|log|read|confirm|close|policy    message other agents", run: msgCmd },
  { name: "tree", usage: "tree <task>    turn state of a task tree", run: treeCmd },
];
