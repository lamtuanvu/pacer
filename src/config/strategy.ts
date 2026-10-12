import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, UsageKind } from "../types";
import { isObj } from "../util";

export const KINDS = [
  "boilerplate", "tests", "docs", "rename", "migration", "feature",
  "debug", "refactor", "performance", "unfamiliar-code", "research",
] as const;
export const NATIVE = ["claude-code", "codex", "cursor", "agy"] as const;
export const PLANNERS = ["claude-code", "codex", "cursor", "opencode"] as const;
export const POLICIES = ["priority", "even", "burn-before-reset", "cheapest-first"] as const;
export type Policy = (typeof POLICIES)[number];

const USAGES: UsageKind[] = ["quota", "metered", "reactive", "unmetered"];
const NATIVE_USAGE: Record<string, UsageKind> = { "claude-code": "quota", codex: "quota", cursor: "reactive", agy: "reactive" };
const DEFAULT_ORDER = ["codex", "cursor", "agy", "opencode"];

export interface ProviderCfg {
  id: string;
  via: "opencode" | null;
  model: string | null;
  usage: UsageKind;
  allowPaid: boolean;
  cooldownS: number;
  quotaSource: "arkcli" | null;
  weeklyTokens: number | null;
}
export interface RouteRule { kinds: string[] | null; executors: string[] }
export interface Strategy {
  name: string;
  planner: string;
  providers: Record<string, ProviderCfg>;
  pacing: { policy: Policy; order: string[]; plannerReserve: number; aheadThreshold: number; behindThreshold: number };
  routing: RouteRule[];
  execution: Record<string, unknown>;
  classifier: Record<string, unknown>;
}

export class StrategyError extends Error {
  constructor(readonly path: string, readonly problems: string[]) {
    super(`invalid strategy ${path}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "StrategyError";
  }
}
export class MissingStrategyError extends Error {
  constructor(readonly path: string) {
    super(`no strategy found at ${path}`);
    this.name = "MissingStrategyError";
  }
}

export function parseSize(v: unknown): number | null {
  if (typeof v === "number") return v;
  const m = /^(\d+(?:\.\d+)?)\s*([kKmMgG]?)$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const mult = { "": 1, k: 1e3, m: 1e6, g: 1e9 }[m[2].toLowerCase() as "" | "k" | "m" | "g"];
  return Number(m[1]) * mult;
}

export function parseDuration(v: unknown): number | null {
  if (typeof v === "number") return v;
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(String(v ?? "").trim());
  if (!m) return null;
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
}

export function validateStrategy(raw: unknown, path: string, name = "default"): Strategy {
  const p: string[] = [];
  if (!isObj(raw)) throw new StrategyError(path, ["top level must be a mapping"]);

  const planner = String(raw.planner ?? "");
  if (!(PLANNERS as readonly string[]).includes(planner)) {
    p.push(`planner must be one of ${PLANNERS.join(", ")} (got "${planner}")`);
  }

  const providers: Record<string, ProviderCfg> = {};
  if (!isObj(raw.providers) || Object.keys(raw.providers).length === 0) {
    p.push("providers must be a non-empty mapping");
  } else {
    for (const [id, v] of Object.entries(raw.providers)) {
      const c = isObj(v) ? v : {};
      const native = (NATIVE as readonly string[]).includes(id);
      const via = c.via === undefined ? null : c.via;
      if (native && via !== null) p.push(`providers.${id}: native providers cannot set "via"`);
      if (!native && via !== "opencode") p.push(`providers.${id}: non-native providers need via: opencode`);
      const model = c.model === undefined ? null : String(c.model);
      if (via === "opencode" && (!model || !model.includes("/"))) {
        p.push(`providers.${id}: model must look like "<provider>/<model>"`);
      }
      const usage = (c.usage ?? (native ? NATIVE_USAGE[id] : "metered")) as UsageKind;
      if (!USAGES.includes(usage)) p.push(`providers.${id}: usage must be one of ${USAGES.join(", ")}`);
      if ((id === "cursor" || id === "agy") && usage === "quota") {
        p.push(`providers.${id}: quota usage is not available for ${id}; use reactive`);
      }
      const quotaSource = c.quota_source === undefined ? null : c.quota_source;
      if (!native && usage === "quota" && quotaSource !== "arkcli") {
        p.push(`providers.${id}: quota usage via opencode needs quota_source: arkcli`);
      }
      const weeklyTokens = isObj(c.budget) ? parseSize(c.budget.weekly_tokens) : null;
      if (usage === "metered" && weeklyTokens === null) {
        p.push(`providers.${id}: metered usage needs budget.weekly_tokens (e.g. 20M)`);
      }
      const cooldownS = c.cooldown === undefined ? 6 * 3600 : parseDuration(c.cooldown);
      if (cooldownS === null) p.push(`providers.${id}: cooldown must look like 30m, 6h or 2d`);
      providers[id] = {
        id,
        via: via === "opencode" ? "opencode" : null,
        model,
        usage,
        allowPaid: c.allow_paid === true,
        cooldownS: cooldownS ?? 6 * 3600,
        quotaSource: quotaSource === "arkcli" ? "arkcli" : null,
        weeklyTokens,
      };
    }
  }

  const pc = isObj(raw.pacing) ? raw.pacing : {};
  const policy = String(pc.policy ?? "priority") as Policy;
  if (!(POLICIES as readonly string[]).includes(policy)) {
    p.push(`pacing.policy must be one of ${POLICIES.join(", ")} (got "${policy}")`);
  }
  let order: string[] = [];
  if (pc.order === undefined) {
    const hasOpencode = Object.values(providers).some((cfg) => cfg.via === "opencode");
    order = DEFAULT_ORDER.filter((id) => Object.hasOwn(providers, id) || (id === "opencode" && hasOpencode));
  } else if (!Array.isArray(pc.order)) {
    p.push("pacing.order must be a list");
  } else {
    order = pc.order.map(String);
    for (const id of order) {
      if (id !== "opencode" && !Object.hasOwn(providers, id)) {
        p.push(`pacing.order: unknown provider "${id}"`);
      }
    }
  }
  const num = (k: string, d: number): number => {
    const v = pc[k] ?? d;
    if (typeof v !== "number") {
      p.push(`pacing.${k} must be a number`);
      return d;
    }
    return v;
  };
  const pacing = {
    policy,
    order,
    plannerReserve: num("planner_reserve", 15),
    aheadThreshold: num("ahead_threshold", 10),
    behindThreshold: num("behind_threshold", -10),
  };
  if (pacing.plannerReserve < 0 || pacing.plannerReserve >= 100) {
    p.push("pacing.planner_reserve must be between 0 and 99");
  }

  const routing: RouteRule[] = [];
  const rawRouting = raw.routing ?? [{ default: Object.keys(providers) }];
  if (!Array.isArray(rawRouting)) {
    p.push("routing must be a list");
  } else {
    rawRouting.forEach((r, i) => {
      if (!isObj(r)) {
        p.push(`routing[${i}] must be a mapping`);
        return;
      }
      const isDefault = Array.isArray(r.default);
      const executors = isDefault ? r.default : r.executors;
      if (!Array.isArray(executors) || executors.length === 0) {
        p.push(`routing[${i}] needs a non-empty executors (or default) list`);
        return;
      }
      for (const e of executors) if (!providers[String(e)]) p.push(`routing[${i}]: unknown provider "${e}"`);
      let kinds: string[] | null = null;
      if (!isDefault) {
        if (!Array.isArray(r.kinds) || r.kinds.length === 0) {
          p.push(`routing[${i}] needs kinds (or use default:)`);
          return;
        }
        kinds = r.kinds.map(String);
        for (const k of kinds) {
          if (!(KINDS as readonly string[]).includes(k)) {
            p.push(`routing[${i}]: unknown kind "${k}" (allowed: ${KINDS.join(", ")})`);
          }
        }
      }
      routing.push({ kinds, executors: executors.map(String) });
    });
  }

  if (p.length) throw new StrategyError(path, p);
  return {
    name, planner, providers, pacing, routing,
    execution: isObj(raw.execution) ? raw.execution : {},
    classifier: isObj(raw.classifier) ? raw.classifier : {},
  };
}

function activeName(ctx: Ctx): string | null {
  const f = join(ctx.pacerHome, "active");
  return existsSync(f) ? readFileSync(f, "utf8").trim() || null : null;
}

export function strategyPath(ctx: Ctx): string {
  const name = activeName(ctx);
  return name ? join(ctx.pacerHome, "strategies", `${name}.yaml`) : join(ctx.pacerHome, "strategy.yaml");
}

function parseFile(path: string, name: string): Strategy {
  if (!existsSync(path)) throw new MissingStrategyError(path);
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new StrategyError(path, [`YAML syntax error: ${(e as Error).message}`]);
  }
  return validateStrategy(raw, path, name);
}

export function loadStrategy(ctx: Ctx): Strategy {
  return parseFile(strategyPath(ctx), activeName(ctx) ?? "default");
}

/** Switch the active strategy. "default" returns to ~/.pacer/strategy.yaml. Returns the active file path. */
export function useStrategy(ctx: Ctx, name: string): string {
  const active = join(ctx.pacerHome, "active");
  if (name === "default") {
    rmSync(active, { force: true });
    return join(ctx.pacerHome, "strategy.yaml");
  }
  const path = join(ctx.pacerHome, "strategies", `${name}.yaml`);
  parseFile(path, name); // validate before switching
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(active, `${name}\n`);
  return path;
}
