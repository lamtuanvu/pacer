import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLANNERS, validateStrategy } from "../config/strategy";
import type { Result } from "../commands/types";
import type { Ctx } from "../types";
import { isObj } from "../util";
import { backupPath } from "./fsx";

const BINS = ["claude", "codex", "cursor-agent", "agy", "opencode", "arkcli", "ollama", "lms", "orca"] as const;
const PLANNER_BINS: Record<string, string> = { "claude-code": "claude", codex: "codex", cursor: "cursor-agent", opencode: "opencode" };

export interface Detection {
  clis: Record<string, string | null>;
  ollamaModel: string | null;
  lmstudioModel: string | null;
}

export async function detect(ctx: Ctx): Promise<Detection> {
  const clis = Object.fromEntries(BINS.map((bin) => [bin, ctx.which(bin)]));
  const d: Detection = { clis, ollamaModel: null, lmstudioModel: null };
  if (clis.ollama) {
    try {
      const r = await ctx.run(["ollama", "list"], 5000);
      if (r.code === 0) d.ollamaModel = r.stdout.trim().split(/\r?\n/).slice(1).find((line) => line.trim())?.trim().split(/\s+/)[0] ?? null;
    } catch { /* An unavailable local server does not prevent CLI discovery. */ }
  }
  if (clis.lms) {
    try {
      const r = await ctx.run(["lms", "ls", "--json"], 5000);
      if (r.code === 0) {
        const models: unknown = JSON.parse(r.stdout);
        if (Array.isArray(models)) {
          const llms = models.filter((m) => isObj(m) && m.type === "llm" && typeof m.modelKey === "string" && m.modelKey.length > 0);
          const model = llms.find((m) => m.trainedForToolUse === true) ?? llms[0];
          d.lmstudioModel = model?.modelKey ?? null;
        }
      }
    } catch { /* Invalid/failed model listings leave the model undetected. */ }
  }
  return d;
}

export function starterStrategy(d: Detection, planner?: string): string {
  const selected = planner ?? PLANNERS.find((p) => d.clis[PLANNER_BINS[p]]);
  if (!selected) throw new Error("no planner CLI detected; install claude, codex, cursor-agent or opencode");
  if (!(PLANNERS as readonly string[]).includes(selected) || !d.clis[PLANNER_BINS[selected]]) {
    throw new Error(`planner ${selected} is unknown or its CLI is missing`);
  }
  const providers: Record<string, string> = {};
  if (d.clis.claude) providers["claude-code"] = "{usage: quota}";
  if (d.clis.codex) providers.codex = "{usage: quota, allow_paid: false}";
  if (d.clis["cursor-agent"]) providers.cursor = "{usage: reactive, cooldown: 6h}";
  if (d.clis.agy) providers.agy = "{usage: reactive, cooldown: 6h}";
  if (d.clis.opencode) {
    if (d.clis.arkcli) providers.byteplus = '{via: opencode, model: "coding-plan/dola-seed-2.0-code", usage: quota, quota_source: arkcli}';
    if (d.clis.ollama && d.ollamaModel) providers.ollama = `{via: opencode, model: ${JSON.stringify(`ollama/${d.ollamaModel}`)}, usage: unmetered}`;
    if (d.clis.lms && d.lmstudioModel) providers.lmstudio = `{via: opencode, model: ${JSON.stringify(`lmstudio/${d.lmstudioModel}`)}, usage: unmetered}`;
  }
  const executors = ["codex", "cursor", "agy", "byteplus", "ollama", "lmstudio", "claude-code"].filter((p) => p !== selected && Object.hasOwn(providers, p));
  if (!executors.length) throw new Error("install at least one executor CLI");
  return [
    `planner: ${selected}`,
    "providers:",
    ...Object.entries(providers).map(([id, cfg]) => `  ${id}: ${cfg}`),
    "# To add opencode-go: use via: opencode, model: opencode-go/<model>,",
    "# usage: metered, and budget.weekly_tokens (e.g. budget: {weekly_tokens: 20M}).",
    "pacing: {policy: priority, planner_reserve: 15}",
    "routing:",
    `  - default: [${executors.join(", ")}]`,
    "",
  ].join("\n");
}

export async function initCmd(ctx: Ctx, options: { force?: boolean; planner?: string } = {}): Promise<Result> {
  const path = join(ctx.pacerHome, "strategy.yaml");
  if (existsSync(path) && !options.force) return { code: 1, out: "", err: `${path} already exists; use --force\n` };
  let out = "";
  try {
    const d = await detect(ctx);
    out = `Detected: ${BINS.filter((bin) => d.clis[bin]).join(", ") || "none"}\nMissing: ${BINS.filter((bin) => !d.clis[bin]).join(", ") || "none"}\n`;
    const text = starterStrategy(d, options.planner);
    validateStrategy(Bun.YAML.parse(text), path);
    mkdirSync(ctx.pacerHome, { recursive: true });
    if (existsSync(path)) {
      const backup = backupPath(path, ctx.now);
      copyFileSync(path, backup);
      out += `Backup: ${backup}\n`;
    }
    writeFileSync(path, text);
    return { code: 0, out: `${out}Wrote ${path}\n`, err: "" };
  } catch (e) {
    return { code: 1, out, err: `${e instanceof Error ? e.message : String(e)}\n` };
  }
}
