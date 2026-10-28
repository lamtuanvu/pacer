import { CoreError } from "../core/errors";
import { loadStrategy } from "../config/strategy";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";
import { isTop, participantKind, relation, rootOf, taskOf } from "./participants";
import { countSentSince } from "./store";
import { parseMessagingConfig, type MessagingConfig, type MsgKind, type Rule } from "./types";

// Lives in types.ts so the strategy loader can parse config without an import cycle.
export { parseMessagingConfig };

export const DEFAULT_RULES: Rule[] = [
  { effect: "allow", from_kind: "human" },
  { effect: "allow", to_kind: "human" },
  { effect: "allow", from_position: "top", relation: ["child", "top_peer"] },
  { effect: "allow", from_position: "child", relation: ["parent"] },
  { effect: "allow", from_position: "child", relation: ["sibling", "child"], grant: "required" },
];

type Layered = Rule & { layer: "tree" | "global" | "default" };
export function effectivePolicy(ctx: Ctx, o: { repo?: string; root?: string } = {}): { config: MessagingConfig; rules: Layered[] } {
  let config: MessagingConfig;
  try { config = loadStrategy(ctx).messaging ?? parseMessagingConfig(undefined); } catch { config = parseMessagingConfig(undefined); }
  const rootTask = o.root && taskOf(o.root) ? readTask(ctx, taskOf(o.root)!) : null;
  const tree = rootTask?.messaging;
  if (tree?.max_turns) config = { ...config, tree: { ...config.tree, max_turns: tree.max_turns } };
  const rules: Layered[] = [
    ...(tree?.rules ?? []).map(r => ({ ...r, layer: "tree" as const })),
    ...config.rules.map(r => ({ ...r, layer: "global" as const })),
    ...(config.defaults ? DEFAULT_RULES.map(r => ({ ...r, layer: "default" as const })) : []),
  ];
  return { config, rules };
}

const kindOk = (want: string | undefined, p: string) => !want || want === "any" || participantKind(p) === want;

export function checkSend(ctx: Ctx, s: { from: string; to: string; kind: MsgKind; bytes: number; hasGrant: boolean }): { decision: "allow"; hold: boolean; rule: number; layer: string } {
  // A message between trees runs under the recipient's tree.
  const root = taskOf(s.to) ? rootOf(ctx, s.to) : rootOf(ctx, s.from);
  const { config, rules } = effectivePolicy(ctx, { root });
  const rel = relation(ctx, s.from, s.to);
  const position = isTop(ctx, s.from) ? "top" : "child";
  const fromTask = taskOf(s.from) ? readTask(ctx, taskOf(s.from)!) : null;
  const toTask = taskOf(s.to) ? readTask(ctx, taskOf(s.to)!) : null;
  if (taskOf(s.to) && !toTask) throw new CoreError("not_found", `Unknown participant ${s.to}`);
  const index = rules.findIndex(r =>
    kindOk(r.from_kind, s.from) && kindOk(r.to_kind, s.to)
    && (!r.from_position || r.from_position === "any" || (participantKind(s.from) !== "human" && r.from_position === position))
    && (!r.relation || r.relation === "any" || r.relation.includes(rel))
    && (!r.kinds || r.kinds.includes(s.kind))
    && (!r.repo || [fromTask?.brief.repo, toTask?.brief.repo].includes(r.repo))
    && (!r.executor || [fromTask?.run?.executor, toTask?.run?.executor].includes(r.executor))
    && (!r.grant || (r.grant === "required") === s.hasGrant));
  const rule = rules[index];
  if (!rule || rule.effect === "deny") {
    throw new CoreError("not_allowed", `Messaging from ${s.from} to ${s.to} (${rel}) is not allowed`, "Run `pacer msg policy check` to see which rule decides.",
      { reason: "msg_forbidden", layer: rule?.layer ?? "none", relation: rel });
  }
  const maxBytes = Math.min(rule.limits?.max_bytes ?? config.message.max_bytes, config.message.max_bytes);
  if (s.bytes > maxBytes) throw new CoreError("too_large", `Message exceeds ${maxBytes} bytes`, undefined, { reason: "msg_too_large", max: maxBytes });
  if (rule.limits?.per_minute && countSentSince(ctx, s.from, ctx.now - 60) >= rule.limits.per_minute) {
    throw new CoreError("conflict", "Message rate limit reached", "Wait a minute before sending again.", { reason: "msg_cap_reached", limit: "per_minute" });
  }
  return { decision: "allow", hold: !!rule.limits?.confirm && participantKind(s.from) !== "human", rule: index, layer: rule.layer };
}
