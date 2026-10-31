import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { projectKey } from "../config/project-strategies";
import { CoreError } from "../core/errors";
import { withLock } from "../core/lock";
import type { Ctx } from "../types";
import { messagingOverrideSchema, ruleSchema, type Rule } from "./types";

const livenessSchema = z.object({
  interval_s: z.number().int().min(10).optional(),
  backoff_max_s: z.number().int().min(10).optional(),
  max_nudges: z.number().int().min(0).optional(),
  nudge_in_modes: z.array(z.enum(["relaxed", "normal", "strict", "emergency"])).optional(),
}).strict();
const entrySchema = messagingOverrideSchema.extend({
  rev: z.number().int().positive().safe(),
  rules: z.array(ruleSchema).max(50),
  liveness: livenessSchema.optional(),
}).strict();
const schema = z.object({
  version: z.literal(1),
  projects: z.record(z.string().refine(projectKey), entrySchema),
}).strict();
export type ProjectMessagingEntry = z.infer<typeof entrySchema>;
type ProjectMessagingFile = z.infer<typeof schema>;
const path = (ctx: Ctx) => join(ctx.pacerHome, "project-messaging.json");
const empty = (): ProjectMessagingFile => ({ version: 1, projects: {} });

export function readProjectMessaging(ctx: Ctx): { data: ProjectMessagingFile; error?: string } {
  let raw: string;
  try { raw = readFileSync(path(ctx), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { data: empty() };
    return { data: empty(), error: `Cannot read project messaging: ${(error as Error).message}` };
  }
  const parsed = schema.safeParse((() => { try { return JSON.parse(raw); } catch { return undefined; } })());
  if (!parsed.success) return { data: empty(), error: `Invalid project messaging: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  return { data: parsed.data };
}

export function projectMessagingGet(ctx: Ctx, repo: string) {
  if (!projectKey(repo)) throw new CoreError("invalid_input", "Invalid repository key");
  const { data, error } = readProjectMessaging(ctx);
  const entry = Object.hasOwn(data.projects, repo) ? data.projects[repo] : undefined;
  return { repo, rev: entry?.rev ?? 0, rules: entry?.rules ?? [],
    ...(entry?.max_turns !== undefined ? { max_turns: entry.max_turns } : {}),
    ...(entry?.liveness !== undefined ? { liveness: entry.liveness } : {}),
    ...(error ? { error } : {}) };
}

export async function projectMessagingWrite(ctx: Ctx, repo: string, expectRev: number, value: { rules: Rule[]; max_turns?: number; liveness?: z.infer<typeof livenessSchema> } | null) {
  if (ctx.readOnly) throw new CoreError("not_allowed", "Cannot change project messaging in read-only mode");
  if (!projectKey(repo) || !Number.isSafeInteger(expectRev) || expectRev < 0 || expectRev >= Number.MAX_SAFE_INTEGER)
    throw new CoreError("invalid_input", "Invalid project messaging revision or repository");
  if (value && !entrySchema.omit({ rev: true }).safeParse(value).success)
    throw new CoreError("invalid_input", "Invalid project messaging policy");
  mkdirSync(ctx.pacerHome, { recursive: true, mode: 0o700 });
  return withLock(ctx, "project-messaging", async () => {
    const { data, error } = readProjectMessaging(ctx);
    if (error) throw new CoreError("invalid_input", error, "Repair project-messaging.json before changing it.");
    const actual = Object.hasOwn(data.projects, repo) ? data.projects[repo]!.rev : 0;
    if (actual !== expectRev) throw new CoreError("conflict", "Project messaging changed in another client", "Reload the policy and review your changes.", { expected: expectRev, actual });
    data.projects[repo] = { rev: actual + 1, ...(value ?? { rules: [] }) };
    const target = path(ctx), temp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(temp, target);
    } finally { rmSync(temp, { force: true }); }
    return projectMessagingGet(ctx, repo);
  });
}
