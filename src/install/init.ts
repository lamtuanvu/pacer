import { allowedPair, type AgentId } from "../config/accounts";
import type { Strategy } from "../config/strategy";
import { accountFolder } from "./role";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLANNERS, validateStrategy } from "../config/strategy";
import type { Result } from "../commands/types";
import type { Ctx } from "../types";
import { isObj } from "../util";
import { backupPath, readText } from "./fsx";
import { readJson } from "../fsutil";
import { migrateStrategy, migrationLines } from "../config/migrate";

const BINS = ["claude", "codex", "cursor-agent", "cursor", "agy", "opencode", "arkcli", "ollama", "lms", "orca"] as const;
const PLANNER_BINS: Record<string, string> = { "claude-code": "claude", codex: "codex", cursor: "cursor-agent", opencode: "opencode" };

export interface Detection {
  clis: Record<string, string | null>;
  ollamaModel: string | null;
  lmstudioModel: string | null;
}

export async function detect(ctx: Ctx): Promise<Detection> {
  const clis = Object.fromEntries(BINS.map((bin) => [bin, ctx.which(bin)]));
  clis["cursor-agent"] ??= clis.cursor;
  const d: Detection = { clis, ollamaModel: null, lmstudioModel: null };
  if (clis.ollama) {
    try {
      // `ollama list` can launch Ollama.app when its server is stopped. Query
      // the running server directly so discovery never starts an application.
      const host = ctx.env.OLLAMA_HOST?.trim() || "http://127.0.0.1:11434";
      const url = new URL(host.includes("://") ? host : `http://${host}`);
      if (!host.includes("://") && !url.port) url.port = "11434";
      url.pathname = "/api/tags";
      const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (response.ok) {
        const body: unknown = await response.json();
        if (isObj(body) && Array.isArray(body.models)) {
          d.ollamaModel = body.models.find(m => isObj(m) && typeof m.name === "string" && m.name.length > 0)?.name ?? null;
        }
      } else await response.body?.cancel();
    } catch { /* An unavailable local server does not prevent CLI discovery. */ }
  }
  if (clis.lms) {
    try {
      // lms auto-starts its app when no port is supplied. An explicit port
      // connects only to an existing server; never retry without that guard.
      const legacyHome = join(ctx.home, ".cache", "lm-studio");
      const home = readText(join(ctx.home, ".lmstudio-home-pointer"))?.trim()
        || (existsSync(legacyHome) ? legacyHome : join(ctx.home, ".lmstudio"));
      const info = readJson<{ port?: unknown }>(ctx.env.LMS_API_SERVER_INFO_PATH || join(home, ".internal", "http-server.json"));
      const port = typeof info?.port === "number" && Number.isInteger(info.port) && info.port > 0 && info.port <= 65535 ? info.port : 41343;
      const r = await ctx.run(["lms", "ls", "--json", "--port", String(port)], 5000);
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
  const selected = planner ?? PLANNERS.find((p) => d.clis[PLANNER_BINS[p]]) ?? "claude-code";
  if (!selected) throw new Error("no planner CLI detected; install claude, codex, cursor-agent or opencode");
  if (!(PLANNERS as readonly string[]).includes(selected)) {
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
  // A missing planner can still be configured for installation later.
  if (selected !== "opencode") providers[selected] ??= selected === "cursor" ? "{usage: reactive}" : "{usage: quota}";
  const executors = ["codex", "cursor", "agy", "byteplus", "ollama", "lmstudio", "claude-code"].filter((p) => p !== selected && Object.hasOwn(providers, p));
  return [
    `planner: ${selected}`,
    Object.keys(providers).length ? "providers:" : "providers: {}",
    ...Object.entries(providers).map(([id, cfg]) => `  ${id}: ${cfg}`),
    "# To add opencode-go: use via: opencode, model: opencode-go/<model>,",
    "# usage: metered, and budget.weekly_tokens (e.g. budget: {weekly_tokens: 20M}).",
    "pacing: {policy: priority, planner_reserve: 15}",
    ...(executors.length ? ["routing:", `  - default: [${executors.join(", ")}]`] : ["routing: []"]),
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
    out += `Wrote ${path}\n`;
    out += migrationLines(path, migrateStrategy(path)).join("\n") + "\n";
    return { code: 0, out, err: "" };
  } catch (e) {
    return { code: 1, out, err: `${e instanceof Error ? e.message : String(e)}\n` };
  }
}

/** Planner account choices are restricted to runnable, compatible accounts. */
export function plannerAccounts(ctx: Ctx, strategy: Strategy, agent: AgentId) {
  return Object.values(strategy.accounts).filter(a => allowedPair(agent, a.kind)
    && (a.source !== "orca" || accountFolder(ctx, a) !== null));
}
