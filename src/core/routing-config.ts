import { isMap, isNode, isSeq, type Node } from "yaml";
import { loadStrategy } from "../config/strategy";
import { resolveRunner } from "../config/runner-id";
import { applyEdit } from "./accounts";
import { CoreError } from "./errors";
import type { Ctx } from "../types";

export interface Rule { kinds?: string[]; executors: string[] }
export function get(ctx: Ctx) {
  const s = loadStrategy(ctx);
  return {rules: s.routing.map(r => ({...(r.kinds ? {kinds: r.kinds} : {}), executors: r.executors})), available: Object.keys(s.runners)};
}
export function set(ctx: Ctx, rules: Rule[]) {
  const s = loadStrategy(ctx);
  if (!rules.length || rules.at(-1)!.kinds !== undefined || rules.slice(0, -1).some(r => r.kinds === undefined)) {
    throw new CoreError("invalid_input", "the default routing rule must be last", "End the rules with one rule without kinds.");
  }
  for (const rule of rules) for (const id of rule.executors) {
    if (!resolveRunner(s, id)) throw new CoreError("invalid_input", `unknown executor ${id}`, `available: ${Object.keys(s.runners).join(", ")}`);
  }
  const values = rules.map(r => r.kinds ? {kinds: r.kinds, executors: r.executors} : {default: r.executors});
  const diff = applyEdit(ctx, doc => {
    // Update lists in existing rules first, retaining their nodes and comments.
    const old = doc.getIn(["routing"]);
    if (isSeq(old)) {
      values.forEach((rule, i) => {
        const current = doc.getIn(["routing", i]);
        if (!isMap(current)) return;
        if (rule.kinds) {
          if (current.has("default")) doc.renameKey(["routing", i, "default"], "executors");
          doc.setList(["routing", i, "kinds"], rule.kinds);
          doc.setList(["routing", i, "executors"], rule.executors!);
        } else {
          doc.deleteIn(["routing", i, "kinds"]);
          if (current.has("executors")) doc.renameKey(["routing", i, "executors"], "default");
          doc.setList(["routing", i, "default"], rule.default!);
        }
      });
      if (old.items.length === values.length) return;
      // setList keeps sequence-level comments; restore the surviving rule nodes.
      const updated = doc.getIn(["routing"]);
      const nodes = isSeq(updated) ? updated.items.slice(0, values.length) : [];
      doc.setList(["routing"], values);
      const result = doc.getIn(["routing"]);
      if (isSeq(result)) {
        nodes.forEach((node, i) => { if (isNode(node)) result.items[i] = node; });
        doc.replaceNode(["routing"], result as Node);
      }
    } else doc.setList(["routing"], values);
  });
  return {diff};
}
