// Pure helpers for adding an OpenCode executor from a detected provider (Settings › Add executor).
import { USAGE_KIND_WORDS, USAGE_UNKNOWN, type UsageKind } from "../../../src/view-model/copy";

export type Group = "signed_in" | "local" | "catalog";
export const GROUP_TITLES: Record<Group, string> = {
  signed_in: "Already signed in to OpenCode",
  local: "Running on this machine",
  catalog: "Connect a provider",
};
const ORDER: Group[] = ["signed_in", "local", "catalog"];
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const CAP_ERROR = "Enter a positive dollar amount, or leave it blank.";

export function groupCandidates<T extends { group: Group }>(list: T[]): [Group, T[]][] {
  return ORDER.map(g => [g, list.filter(c => c.group === g)] as [Group, T[]]).filter(([, items]) => items.length > 0);
}

/** "262K context", or "1M context" from a million tokens up. */
export function contextLabel(tokens: number): string {
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M context` : `${Math.round(tokens / 1000)}K context`;
}

export function modelFacts(m: { context: number; costIn: number | null; costOut: number | null }): string {
  const context = contextLabel(m.context);
  return m.costIn !== null && m.costOut !== null ? `${context} · $${m.costIn}/$${m.costOut} per M` : context;
}

/** A blank cap means none; anything else must be a positive dollar amount. A string is the error to show. */
export function parseCapUsd(text: string): number | undefined | string {
  const t = text.trim().replace(/^\$/, "");
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : CAP_ERROR;
}

export function searchCandidates<T extends { provider: string; name: string }>(list: T[], q: string, limit = 12): T[] {
  const needle = q.trim().toLowerCase();
  return list.filter(c => !needle || c.provider.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle)).slice(0, limit);
}

/** The catalog's usage type, or "Usage unknown" when it has no answer (the user picks one later). */
export const usagePill = (u: { usage: UsageKind; known?: boolean }) => u.known === false ? USAGE_UNKNOWN : USAGE_KIND_WORDS[u.usage];

export interface ModelLike { id: string; context: number; output: number; tools: boolean }
export interface AddInput {
  candidate: { group: Group; provider: string; base_url?: string };
  model: ModelLike;
  usage: UsageKind;
  cap: string;
  name: string;
}

/** The account.add params for a chosen candidate, or the error to show. The executor's test task runs afterwards
 * as the wizard's step 4 check, so the add itself does not test. */
export function addParams(input: AddInput): { params: Record<string, unknown> } | { error: string } {
  if (!NAME.test(input.name)) return { error: "Use lowercase letters, digits and hyphens, starting with a letter or digit." };
  const { candidate, model } = input;
  if (candidate.group === "local") {
    return { params: { kind: "endpoint", name: input.name, base_url: candidate.base_url, key_source: "none",
      models: [{ id: model.id, context: model.context, output: model.output, tools: model.tools }], usage: "unmetered", test: false } };
  }
  const cap = input.usage === "metered" ? parseCapUsd(input.cap) : undefined;
  if (typeof cap === "string") return { error: cap };
  return { params: { kind: "endpoint", source: "opencode", provider: candidate.provider, model: model.id, name: input.name,
    ...(input.usage !== "metered" ? { usage: input.usage } : {}), ...(cap !== undefined ? { cap_usd: cap } : {}), test: false } };
}
