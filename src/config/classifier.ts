import { ADAPTER_IDS, DECISIONS, type AdapterId, type DecisionName } from "../classify/types";
import { isObj } from "../util";
import type { ProviderCfg, Strategy } from "./strategy";

export interface ClassifierConfig {
  configured: boolean;
  default: AdapterId;
  decisions: Record<DecisionName, { use: AdapterId; minConfidence: number; verifyKind: boolean; maxForCheap: number }>;
  shadow: AdapterId[];
  shadowExternal: boolean;
  timeoutMs: number;
  logState: "full" | "trimmed" | "none";
  tiers: Record<string, "cheap" | "capable">;
  adapters: {
    ollama: { baseUrl: string; model: string; maxTokens: number; keyEnv: string | null };
    jev: { baseUrl: string; model: string; keyEnv: string; usdPerMtokIn: number | null; usdPerMtokOut: number | null };
  };
  bench: { redact: boolean; timeoutMs: number };
}

export class ClassifierConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid classifier:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ClassifierConfigError";
  }
}

export function validateClassifier(raw: unknown, providers: Record<string, ProviderCfg>): ClassifierConfig {
  const problems: string[] = [];
  const object = (value: unknown, path: string): Record<string, unknown> => {
    if (value === undefined) return {};
    if (isObj(value)) return value;
    problems.push(`${path} must be a mapping`);
    return {};
  };
  const keys = (value: Record<string, unknown>, allowed: readonly string[], path: string) => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) problems.push(`${path}.${key}: unknown key`);
    }
  };
  const adapter = (value: unknown, fallback: AdapterId, path: string): AdapterId => {
    if (value === undefined) return fallback;
    if (typeof value === "string" && (ADAPTER_IDS as readonly string[]).includes(value)) return value as AdapterId;
    problems.push(`${path} must be one of ${ADAPTER_IDS.join(", ")}`);
    return fallback;
  };
  const number = (value: unknown, fallback: number, path: string, valid: (n: number) => boolean, requirement: string): number => {
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isFinite(value) && valid(value)) return value;
    problems.push(`${path} must be ${requirement}`);
    return fallback;
  };
  const unit = (value: unknown, fallback: number, path: string) => number(value, fallback, path, (n) => n >= 0 && n <= 1, "a number in [0,1]");
  const positive = (value: unknown, fallback: number, path: string) => number(value, fallback, path, (n) => n > 0, "a positive number");
  const boolean = (value: unknown, fallback: boolean, path: string): boolean => {
    if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    problems.push(`${path} must be a boolean`);
    return fallback;
  };
  const string = (value: unknown, fallback: string, path: string): string => {
    if (value === undefined) return fallback;
    if (typeof value === "string" && value.trim().length > 0) return value;
    problems.push(`${path} must be a non-empty string`);
    return fallback;
  };
  const url = (value: unknown, fallback: string, path: string): string => {
    if (value === undefined) return fallback;
    if (typeof value === "string") {
      try {
        const parsed = new URL(value);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") return value;
      } catch { /* Report alongside the other config problems. */ }
    }
    problems.push(`${path} must be an http(s) URL`);
    return fallback;
  };

  const input = object(raw, "classifier");
  keys(input, ["default", "decisions", "shadow", "shadow_external", "timeout_ms", "log_state", "tiers", "adapters", "bench"], "classifier");
  const defaultAdapter = adapter(input.default, "rules", "classifier.default");
  const decisionInput = object(input.decisions, "classifier.decisions");
  keys(decisionInput, DECISIONS, "classifier.decisions");
  const decisions = {} as ClassifierConfig["decisions"];
  for (const name of DECISIONS) {
    const path = `classifier.decisions.${name}`;
    const d = object(decisionInput[name], path);
    keys(d, ["use", "min_confidence", "verify_kind", "max_for_cheap"], path);
    decisions[name] = {
      use: adapter(d.use, defaultAdapter, `${path}.use`),
      minConfidence: unit(d.min_confidence, 0.6, `${path}.min_confidence`),
      verifyKind: boolean(d.verify_kind, false, `${path}.verify_kind`),
      maxForCheap: unit(d.max_for_cheap, name === "difficulty" && Object.hasOwn(decisionInput, name) ? 0.6 : 0, `${path}.max_for_cheap`),
    };
  }
  const shadow: AdapterId[] = [];
  if (input.shadow !== undefined) {
    if (!Array.isArray(input.shadow)) problems.push("classifier.shadow must be a list");
    else input.shadow.forEach((value, i) => shadow.push(adapter(value, "rules", `classifier.shadow[${i}]`)));
  }
  let logState: ClassifierConfig["logState"] = "full";
  if (input.log_state !== undefined) {
    if (input.log_state === "full" || input.log_state === "trimmed" || input.log_state === "none") logState = input.log_state;
    else problems.push("classifier.log_state must be one of full, trimmed, none");
  }
  const tiers: ClassifierConfig["tiers"] = {};
  for (const [id, provider] of Object.entries(providers)) tiers[id] = provider.via === "opencode" ? "cheap" : "capable";
  for (const [id, tier] of Object.entries(object(input.tiers, "classifier.tiers"))) {
    if (!Object.hasOwn(providers, id)) problems.push(`classifier.tiers.${id}: unknown provider`);
    if (tier !== "cheap" && tier !== "capable") problems.push(`classifier.tiers.${id} must be cheap or capable`);
    else if (Object.hasOwn(providers, id)) tiers[id] = tier;
  }
  const adapters = object(input.adapters, "classifier.adapters");
  keys(adapters, ["ollama", "jev"], "classifier.adapters");
  const local = object(adapters.ollama, "classifier.adapters.ollama");
  const jev = object(adapters.jev, "classifier.adapters.jev");
  keys(local, ["base_url", "model", "max_tokens", "key_env"], "classifier.adapters.ollama");
  keys(jev, ["base_url", "model", "key_env", "usd_per_mtok_in", "usd_per_mtok_out"], "classifier.adapters.jev");
  const price = (value: unknown, path: string) => value === undefined || value === null ? null : number(value, 0, path, (n) => n >= 0, "a non-negative number");
  const bench = object(input.bench, "classifier.bench");
  keys(bench, ["redact", "timeout_ms"], "classifier.bench");
  const config: ClassifierConfig = {
    configured: Object.keys(input).length > 0,
    default: defaultAdapter, decisions, shadow,
    shadowExternal: boolean(input.shadow_external, false, "classifier.shadow_external"),
    timeoutMs: positive(input.timeout_ms, 3000, "classifier.timeout_ms"),
    logState, tiers,
    adapters: {
      ollama: {
        baseUrl: url(local.base_url, "http://127.0.0.1:1234/v1", "classifier.adapters.ollama.base_url"),
        model: string(local.model, "qwen3.6-35b-a3b", "classifier.adapters.ollama.model"),
        maxTokens: number(local.max_tokens, 512, "classifier.adapters.ollama.max_tokens", (n) => n > 0 && Number.isInteger(n), "a positive integer"),
        keyEnv: local.key_env === undefined || local.key_env === null ? null : string(local.key_env, "", "classifier.adapters.ollama.key_env"),
      },
      jev: {
        baseUrl: url(jev.base_url, "https://api.typesafe.ai", "classifier.adapters.jev.base_url"),
        model: string(jev.model, "jev-latest", "classifier.adapters.jev.model"),
        keyEnv: string(jev.key_env, "TYPESAFE_API_KEY", "classifier.adapters.jev.key_env"),
        usdPerMtokIn: price(jev.usd_per_mtok_in, "classifier.adapters.jev.usd_per_mtok_in"),
        usdPerMtokOut: price(jev.usd_per_mtok_out, "classifier.adapters.jev.usd_per_mtok_out"),
      },
    },
    bench: { redact: boolean(bench.redact, true, "classifier.bench.redact"), timeoutMs: positive(bench.timeout_ms, 30000, "classifier.bench.timeout_ms") },
  };
  if (problems.length) throw new ClassifierConfigError(problems);
  return config;
}

export function classifierConfig(s: Strategy): ClassifierConfig {
  return validateClassifier(s.classifier, s.providers);
}
