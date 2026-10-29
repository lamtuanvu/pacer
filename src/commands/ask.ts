import { callOp } from "../api/ops";
import type { ActionCard, AssistantScope, TurnView } from "../assistant/types";
import type { Ctx } from "../types";
import type { Result } from "./types";

export const ASK_USAGE = 'pacer ask "<question>" [--scope dispatch|task:<id>|repo:<path>] [--json]';

function parseScope(raw: string | undefined): AssistantScope {
  if (!raw || raw === "dispatch") return { kind: "dispatch", days: 7 };
  if (raw.startsWith("task:") && raw.length > 5) return { kind: "task", id: raw.slice(5) };
  if (raw.startsWith("repo:") && raw.length > 5) return { kind: "repo", repo: raw.slice(5) };
  throw new Error(`unknown scope "${raw}"; use dispatch, task:<id> or repo:<path>`);
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The equivalent pacer command for a proposal. Printed for the user to run; never run by `pacer ask`. */
export function equivalentCommand(card: ActionCard): string | null {
  const id = typeof card.params.id === "string" ? card.params.id : "";
  switch (card.op.replace(/^(dispatch|task)\./, "")) {
    case "retry": return `pacer retry ${id}${card.params.feedback ? ` --feedback ${quote(String(card.params.feedback))}` : ""}`;
    case "stop": return `pacer stop ${id}`;
    case "answer": return `pacer answer ${id} ${quote(String(card.params.text ?? ""))}`;
    case "delegation.pause": return `pacer pause ${String(card.params.for)}`;
    case "delegation.resume": return "pacer resume";
    case "submit": return `pacer delegate ${quote(String(card.params.goal ?? ""))} --repo ${quote(String(card.params.repo ?? ""))}`;
    default: return null;
  }
}

/** `pacer ask`: ask once and print the answer. Proposals print as commands. */
export async function askCommand(args: string[], ctx: Ctx, o: { poll?: (ms: number) => Promise<void>; timeoutMs?: number } = {}): Promise<Result> {
  let scope: AssistantScope, json = false;
  const words: string[] = [];
  try {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--json") json = true;
      else if (a === "--scope") { scope = parseScope(args[++i]); }
      else if (a.startsWith("--scope=")) scope = parseScope(a.slice(8));
      else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
      else words.push(a);
    }
    scope ??= { kind: "dispatch", days: 7 };
    if (words.length !== 1 || !words[0]!.trim()) throw new Error(`usage: ${ASK_USAGE}`);
    const started = await callOp(ctx, "assistant.ask", { text: words[0], scope, requestId: `cli-${crypto.randomUUID()}` }) as { turnId: string };
    const sleep = o.poll ?? ((ms: number) => Bun.sleep(ms));
    const until = Date.now() + (o.timeoutMs ?? 130_000);
    let turn: TurnView;
    for (;;) {
      turn = await callOp(ctx, "assistant.turn", { turnId: started.turnId }) as TurnView;
      if (turn.state !== "running") break;
      if (Date.now() > until) return { code: 1, out: "", err: "The assistant did not answer in time." };
      await sleep(500);
    }
    if (json) return { code: turn.state === "done" ? 0 : 1, out: JSON.stringify({ ...turn, commands: turn.cards.map(equivalentCommand).filter(Boolean) }), err: "" };
    if (turn.state !== "done") return { code: 1, out: "", err: turn.error ?? `The assistant ${turn.state === "cancelled" ? "was cancelled" : "could not answer"}.` };
    const commands = turn.cards.flatMap(c => { const cmd = equivalentCommand(c); return cmd ? [`  ${cmd}    # ${c.summary}`] : []; });
    const links = turn.citations.map(c => `  ${c.label}`);
    return { code: 0, out: [turn.answer ?? "", ...(links.length ? ["", "Sources:", ...links] : []), ...(commands.length ? ["", "Proposed (not run):", ...commands] : [])].join("\n"), err: "" };
  } catch (e) {
    return { code: 2, out: "", err: e instanceof Error ? e.message : String(e) };
  }
}
