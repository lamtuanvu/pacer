import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseRunnerId } from "./runner-id";
import { canonical } from "./hosts";
import { CoreError } from "../core/errors";
import { withLock } from "../core/lock";
import type { Ctx } from "../types";

export interface ProjectStrategyEntry { rev: number; executors: string[] | null }
export interface ProjectStrategyFile { version: 1; projects: Record<string, ProjectStrategyEntry> }
export const PROJECT_STRATEGIES_LOCK = "project-strategies";
export const projectKey = (key: string) => canonical(key) || /^local:[0-9a-f]{12}$/.test(key);
const reference = z.string().refine(value => {
  const parsed = parseRunnerId(value);
  return !!parsed?.account && value.includes("@") && value === `${parsed.agent}#${parsed.account}@${parsed.host ?? "local"}`;
}, "executor must identify its agent, account and host");
const executors = z.array(reference).min(1).refine(ids => new Set(ids).size === ids.length, "duplicate executor");
const schema = z.object({
  version: z.literal(1),
  projects: z.record(z.string().refine(projectKey), z.object({ rev: z.number().int().positive().safe(), executors: executors.nullable() }).strict()),
}).strict();
const file = (ctx: Ctx) => join(ctx.pacerHome, "project-strategies.json");

/** Only a missing file inherits global routing. Invalid or unreadable policy fails closed. */
export function readProjectStrategies(ctx: Ctx): ProjectStrategyFile {
  let text: string;
  try { text = readFileSync(file(ctx), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: {} };
    throw new CoreError("invalid_input", "Cannot read project strategies", "Check project-strategies.json permissions before delegating.");
  }
  try { return schema.parse(JSON.parse(text)); }
  catch { throw new CoreError("invalid_input", "Invalid project strategies", "Repair project-strategies.json before delegating; no global fallback was used."); }
}

/** Caller holds PROJECT_STRATEGIES_LOCK; used for a short final routing decision too. */
export function projectRevision(data: ProjectStrategyFile, key: string): number {
  return Object.hasOwn(data.projects, key) ? data.projects[key].rev : 0;
}

export async function writeProjectStrategy(ctx: Ctx, key: string, values: string[] | null, expectRev: number): Promise<ProjectStrategyEntry> {
  if (ctx.readOnly) throw new CoreError("not_allowed", "Cannot change project strategies in read-only mode");
  if (!projectKey(key) || !Number.isSafeInteger(expectRev) || expectRev < 0 || expectRev >= Number.MAX_SAFE_INTEGER || (values !== null && !executors.safeParse(values).success)) {
    throw new CoreError("invalid_input", "Invalid project strategy", "Choose a repository and at least one distinct configured executor.");
  }
  mkdirSync(ctx.pacerHome, { recursive: true, mode: 0o700 });
  return withLock(ctx, PROJECT_STRATEGIES_LOCK, async () => {
    const data = readProjectStrategies(ctx), current = projectRevision(data, key);
    if (current !== expectRev) throw new CoreError("conflict", "Project strategy changed in another client", "Reload the project strategy and review your changes.", { expected: expectRev, actual: current });
    const entry = { rev: current + 1, executors: values === null ? null : [...values] };
    data.projects[key] = entry;
    const target = file(ctx), tmp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(tmp, target);
    } finally { rmSync(tmp, { force: true }); }
    return entry;
  });
}
