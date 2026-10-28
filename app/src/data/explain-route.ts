import { ApiError, type BrowserApi } from "./api";

/**
 * Typed client for the read-only `dispatch.explain` op (docs/specs/2026-10-28-route-explanation-design.md).
 * The op is additive and may be missing on the connected service, so callers get an explicit `unavailable`
 * state instead of an error, and the composer keeps working without a routing preview.
 */
export const EXPLAIN_OP = "dispatch.explain";

export interface ExplainRouteParams {
  repo: string;
  goal: string;
  kind?: string;
  executor?: string;
}
export type ReasonFacts = Record<string, string | number | boolean | null>;
export interface RouteReason { code: string; outcome: "pass" | "fail" | "info"; subject?: string; facts: ReasonFacts; text: string }
export interface RouteChoice { executor: string; account: string; runner: string; model: { kind: "exact"; id: string } | { kind: "executor-default" }; host: string | null }
export interface RouteFallback { executor: string; account: string; state: "eligible" | "excluded"; step?: string; reason?: RouteReason }
export interface PlannerWindow { account: string; usedPct: number; pacePct: number | null; mode: string }
export type PlannerCost =
  | { state: "unknown"; reason: string }
  | { state: "estimate"; tokens: { median: number; p80: number }; samples: number; basis: "kind" | "kind+repo"; window: PlannerWindow | null };
export interface RouteExplanation {
  schemaVersion: 1;
  revision: string;
  at: number;
  observedAt: number | null;
  outcome: "select" | "queue" | "fail" | "override";
  kind: { value: string | null; source: "given" | "detected" | "unknown" };
  strategy: { name: string; draft: boolean; source: "project" | "strategy" | "built-in" };
  engine: { id: string; version: string; fallback?: { from: string; reason: "invalid" | "timeout" } };
  chosen: RouteChoice | null;
  step: { id: string; index: number; skipped: { id: string; reason: string }[] } | null;
  reasons: RouteReason[];
  fallbacks: RouteFallback[];
  planner: PlannerCost;
  uncertainty: RouteReason[];
}
export type ExplainResult =
  | { state: "ok"; explanation: RouteExplanation }
  | { state: "unavailable" }
  | { state: "error"; error: unknown };

/** Only the params the spec documents; empty optional fields are omitted so the strict schema accepts them. */
export function explainParams(input: ExplainRouteParams): ExplainRouteParams {
  return {
    repo: input.repo, goal: input.goal,
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.executor ? { executor: input.executor } : {}),
  };
}

/** `ops` is the service's hello list; a service without the op is `unavailable` without a request. */
export async function explainRoute(api: Pick<BrowserApi, "call">, ops: ReadonlySet<string>, input: ExplainRouteParams): Promise<ExplainResult> {
  if (!ops.has(EXPLAIN_OP)) return { state: "unavailable" };
  try {
    return { state: "ok", explanation: await api.call<RouteExplanation>(EXPLAIN_OP, explainParams(input)) };
  } catch (error) {
    // Only unknown_op means the op is missing: unknown_executor and not_found are also 404s from a service that has it.
    if (error instanceof ApiError && error.code === "unknown_op") return { state: "unavailable" };
    return { state: "error", error };
  }
}
