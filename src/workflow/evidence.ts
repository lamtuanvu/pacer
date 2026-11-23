// Frame-provided evidence result shape for agent-driven tests (Phase 5 / D9).
import type { Ctx } from "../types";
import { isPlainObject } from "./schema";
import { artifactsExist } from "./artifacts";

export const EVIDENCE_STATUSES = ["pass", "fail", "unverified"] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];
export const EVIDENCE_NEEDS = ["browser", "desktop", "tui"] as const;
export type EvidenceNeed = (typeof EVIDENCE_NEEDS)[number];

export type EvidenceSurface = {
  name: string;
  status: EvidenceStatus;
  steps: string[];
  artifacts: string[];
};

export type EvidenceResult = {
  summary: string;
  passed: number;
  failed: number;
  unverified: number;
  surfaces: EvidenceSurface[];
  report?: string;
};

/** Validate a step result against the frame evidence shape. Returns error messages. */
export function validateEvidenceResult(ctx: Ctx, runId: string, result: unknown): string[] {
  if (!isPlainObject(result)) return ["result must be a JSON object"];
  const errors: string[] = [];
  if (typeof result.summary !== "string" || !result.summary.trim()) {
    errors.push("missing required key 'summary'");
  }
  for (const key of ["passed", "failed", "unverified"] as const) {
    if (typeof result[key] !== "number" || !Number.isInteger(result[key]) || (result[key] as number) < 0) {
      errors.push(`'${key}' must be a non-negative integer`);
    }
  }
  if (!Array.isArray(result.surfaces)) {
    errors.push("'surfaces' must be an array");
    return errors;
  }
  const surfaces = result.surfaces;
  let passed = 0, failed = 0, unverified = 0;
  const artIds: string[] = [];
  for (let i = 0; i < surfaces.length; i++) {
    const s = surfaces[i];
    const path = `surfaces[${i}]`;
    if (!isPlainObject(s)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    if (typeof s.name !== "string" || !s.name.trim()) errors.push(`${path}.name is required`);
    if (typeof s.status !== "string" || !(EVIDENCE_STATUSES as readonly string[]).includes(s.status)) {
      errors.push(`${path}.status must be pass, fail or unverified`);
    } else if (s.status === "pass") passed++;
    else if (s.status === "fail") failed++;
    else unverified++;
    if (!Array.isArray(s.steps) || !s.steps.every(x => typeof x === "string")) {
      errors.push(`${path}.steps must be an array of strings`);
    }
    if (!Array.isArray(s.artifacts) || !s.artifacts.every(x => typeof x === "string")) {
      errors.push(`${path}.artifacts must be an array of artifact ids`);
    } else {
      for (const id of s.artifacts as string[]) artIds.push(id);
    }
  }
  if (typeof result.passed === "number" && result.passed !== passed) {
    errors.push(`passed count ${result.passed} does not match ${passed} pass surface(s)`);
  }
  if (typeof result.failed === "number" && result.failed !== failed) {
    errors.push(`failed count ${result.failed} does not match ${failed} fail surface(s)`);
  }
  if (typeof result.unverified === "number" && result.unverified !== unverified) {
    errors.push(`unverified count ${result.unverified} does not match ${unverified} unverified surface(s)`);
  }
  if (result.report !== undefined) {
    if (typeof result.report !== "string") errors.push("'report' must be an artifact id");
    else artIds.push(result.report);
  }
  const unique = [...new Set(artIds)];
  if (!artifactsExist(ctx, runId, unique)) {
    errors.push("unknown artifact id in evidence");
  }
  return errors;
}

/** Prompt note when no enabled runner advertises a needed tool. */
export function missingNeedsPrompt(needs: EvidenceNeed[], available: ReadonlySet<EvidenceNeed>): string {
  const missing = needs.filter(n => !available.has(n));
  if (missing.length === 0) return "";
  return `No executor advertises ${missing.join(", ")}; report those surfaces as unverified.`;
}
