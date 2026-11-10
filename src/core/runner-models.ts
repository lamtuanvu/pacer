import { readFileSync } from "node:fs";
import { isNode } from "yaml";
import { loadStrategy, strategyPath } from "../config/strategy";
import { isPlannerRunner, resolveRunner } from "../config/runner-id";
import { modelDeclarationSchema } from "../dispatch/types";
import { availableModels, closestModels, isOffered } from "../models/available";
import { ensureAccounts } from "./accounts";
import { withLock } from "./lock";
import { CoreError } from "./errors";
import { strategyRevision } from "./executor-settings";
import type { Ctx } from "../types";
import type { RunnerCfg } from "../config/accounts";

export interface ModelDeclaration { id: string; tier: "small" | "medium" | "frontier" | "unknown"; strengths?: string[]; tools?: boolean; context?: number }
export interface RunnerModels { revision: string; runner: string; default: string | null; models: ModelDeclaration[] }

/**
 * Hand-edited drift warns instead of failing: a default outside the allowed
 * list and unrated models still load and keep routing working. Pure; also
 * backs the doctor check and the CLI face, and keeps the parsed strategy free
 * of warning-only fields.
 */
export function modelDeclarationWarnings(runner: RunnerCfg): string[] {
  const warnings: string[] = [];
  if (runner.models && typeof runner.model === "string" && !runner.models.some(m => m.id === runner.model)) warnings.push(`runners.${runner.id}: default model "${runner.model}" is not in models`);
  for (const m of runner.models ?? []) if (m.tier === "unknown") warnings.push(`runners.${runner.id}: model "${m.id}" is unrated (tier unknown)`);
  return warnings;
}

/** Read one executor's default model and allowed tiered models with the current strategy revision. */
export function readRunnerModels(ctx: Ctx, runner: string): RunnerModels {
  const path = strategyPath(ctx), text = readFileSync(path, "utf8"), s = loadStrategy(ctx);
  if (readFileSync(path, "utf8") !== text) throw new CoreError("conflict", "Executor settings changed. Reload saved settings.");
  const id = resolveRunner(s, runner)?.id;
  const r = id ? s.runners[id] : undefined;
  if (!r) throw new CoreError("invalid_input", `unknown runner ${runner}`);
  return { revision: strategyRevision(text), runner: r.id, default: r.model, models: r.models ?? [] };
}

/** Validate and save the default model and allowed tiered models in one revision-checked edit under the executor-settings CAS lock. */
export async function saveRunnerModels(ctx: Ctx, input: { id: string; expectedRevision: string; default: string; models: ModelDeclaration[] }): Promise<RunnerModels & {warnings: string[]}> {
  return await withLock(ctx, "executor-settings", async () => {
    const path = strategyPath(ctx), text = readFileSync(path, "utf8"), s = loadStrategy(ctx);
    if (input.expectedRevision !== strategyRevision(text)) throw new CoreError("conflict", "Executor settings changed elsewhere.", "Reload saved settings, then reapply your changes.");
    const id = resolveRunner(s, input.id)?.id;
    const r = id ? s.runners[id] : undefined;
    if (!r) throw new CoreError("invalid_input", `unknown runner ${input.id}`);
    if (isPlannerRunner(s, r)) throw new CoreError("not_allowed", "cannot edit the planner runner");
    const parsed = modelDeclarationSchema.array().max(256).safeParse(input.models);
    if (!parsed.success) throw new CoreError("invalid_input", "models must be valid model declarations (id, tier, optional strengths).");
    const models = parsed.data;
    if (new Set(models.map(m => m.id)).size !== models.length) throw new CoreError("invalid_input", "duplicate models");
    if (models.length && !models.some(m => m.id === input.default)) throw new CoreError("invalid_input", `default must be one of models: ${models.map(m => m.id).join(", ")}`);
    // Every saved id is checked against the live listing: an absent model from a known
    // listing is refused with the closest offers; an unknown listing only warns.
    const list = await availableModels(ctx, r.id);
    const warnings: string[] = [];
    for (const mid of models.length ? models.map(m => m.id) : [input.default]) {
      const offered = isOffered(list, mid);
      if (offered === false) {
        const account = s.accounts[r.account];
        const provider = account?.provider ?? r.account;
        const suggestions = closestModels(list, mid);
        throw new CoreError("invalid_input", `${mid} is not offered by ${provider}`, suggestions.length ? `Available: ${suggestions.join(", ")}` : undefined);
      }
      if (offered === null && list.source !== "none") warnings.push(`${mid} could not be checked: ${list.note ?? ""}`);
    }
    // Migration preserves old values and creates its established backup. Draft
    // validation precedes it; both fields still commit in one edit.
    const prepared = ensureAccounts(ctx), source = readFileSync(path, "utf8");
    if (!prepared.migrated && source !== text) throw new CoreError("conflict", "Executor settings changed. Reload saved settings.");
    await prepared.edit(doc => {
      if (doc.toString() !== source) throw new Error("strategy changed during edit; retry");
      const raw = doc.getIn(["runners"]);
      const declarations = (isNode(raw) ? raw.toJSON() : raw) as Record<string, unknown> | undefined;
      const key = Object.keys(declarations ?? {}).find(k => resolveRunner(prepared.strategy, k)?.id === r.id) ?? r.id;
      if (models.length) {
        doc.setIn(["runners", key, "model"], input.default);
        doc.setIn(["runners", key, "models"], models);
      } else {
        doc.deleteIn(["runners", key, "models"]);
        doc.setIn(["runners", key, "model"], input.default);
      }
    });
    const updated = loadStrategy(ctx), updater = updated.runners[r.id];
    if (updater) warnings.push(...modelDeclarationWarnings(updater));
    return { revision: strategyRevision(readFileSync(path, "utf8")), runner: r.id, default: updater?.model ?? null, models: updater?.models ?? [], warnings };
  });
}
