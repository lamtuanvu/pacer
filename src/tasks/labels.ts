import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";

const labelsFile = (ctx: Ctx) => join(ctx.pacerHome, "labels.jsonl");

/** Ground-truth labels for the classifier benchmark (spec §3.10). */
export function appendLabel(ctx: Ctx, label: Record<string, unknown>): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  appendFileSync(labelsFile(ctx), `${JSON.stringify({ ts: ctx.now, ...label })}\n`);
}

export function readLabels(ctx: Ctx): Record<string, unknown>[] {
  if (!existsSync(labelsFile(ctx))) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(labelsFile(ctx), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip a corrupt line
    }
  }
  return out;
}
