import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { redactState } from "./state";
import type { DecisionEntry } from "./types";

export function decisionsFile(ctx: Ctx): string {
  return join(ctx.pacerHome, "decisions.jsonl");
}

export function newDecisionId(): string {
  return `d-${randomBytes(6).toString("hex")}`;
}

export function appendDecision(ctx: Ctx, entry: DecisionEntry): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  appendFileSync(decisionsFile(ctx), `${JSON.stringify(entry)}\n`);
}

export function readDecisions(ctx: Ctx, sinceTs = 0): DecisionEntry[] {
  let content: string;
  try {
    content = readFileSync(decisionsFile(ctx), "utf8");
  } catch {
    return [];
  }
  const entries: DecisionEntry[] = [];
  for (const line of content.split("\n")) {
    try {
      const entry = JSON.parse(line) as DecisionEntry;
      if (entry && typeof entry.ts === "number" && entry.ts >= sinceTs) entries.push(entry);
    } catch { /* A corrupt line must not hide other decisions. */ }
  }
  return entries;
}

export function loggedState(state: string, mode: "full" | "trimmed" | "none", home: string): string | null {
  if (mode === "none") return null;
  return mode === "trimmed" ? redactState(state, home) : state;
}
