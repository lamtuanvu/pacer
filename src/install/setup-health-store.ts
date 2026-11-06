import { join } from "node:path";
import { isObj } from "../util";
import type { SetupHealthFingerprint, SetupHealthOutcome, SetupHealthStepId, SetupHealthStepState, SetupHealthTrigger } from "../view-model/setup-health";
import { readInstallFile, writeInstallFile } from "./atomic";

export interface SetupHealthPassRecord {
  schema: 1;
  fingerprint: SetupHealthFingerprint;
  trigger: SetupHealthTrigger;
  outcome: SetupHealthOutcome;
  durationSeconds?: number;
}

const STEP_IDS: SetupHealthStepId[] = [
  "service",
  "detect_agents",
  "integrations",
  "usage_eligibility",
  "ready",
];

const STEP_STATES = new Set<SetupHealthStepState>([
  "waiting",
  "running",
  "passed",
  "needs_attention",
  "failed",
  "timed_out",
]);

export function setupHealthPath(ctx: { pacerHome: string }): string {
  return join(ctx.pacerHome, "setup-health.json");
}

function parseFingerprint(value: unknown): SetupHealthFingerprint | null {
  if (!isObj(value) || value.schema !== 1) return null;
  if (typeof value.appVersion !== "string" || typeof value.serviceVersion !== "string") return null;
  if (typeof value.attentionCount !== "number" || !Number.isFinite(value.attentionCount)) return null;
  if (typeof value.checkedAt !== "number" || !Number.isFinite(value.checkedAt)) return null;
  if (!isObj(value.integrationHashes)) return null;
  const integrationHashes: Record<string, string> = {};
  for (const [key, hash] of Object.entries(value.integrationHashes)) {
    if (typeof hash !== "string") return null;
    integrationHashes[key] = hash;
  }
  if (!isObj(value.stepVerdicts)) return null;
  const stepVerdicts = {} as Record<SetupHealthStepId, SetupHealthStepState>;
  for (const id of STEP_IDS) {
    const state = value.stepVerdicts[id];
    if (typeof state !== "string" || !STEP_STATES.has(state as SetupHealthStepState)) return null;
    stepVerdicts[id] = state as SetupHealthStepState;
  }
  return {
    schema: 1,
    appVersion: value.appVersion,
    serviceVersion: value.serviceVersion,
    integrationHashes,
    attentionCount: value.attentionCount,
    checkedAt: Math.floor(value.checkedAt),
    stepVerdicts,
  };
}

function parseRecord(text: string): SetupHealthPassRecord | null {
  try {
    const data: unknown = JSON.parse(text);
    if (!isObj(data) || data.schema !== 1) return null;
    if (data.trigger !== "startup" && data.trigger !== "update" && data.trigger !== "manual") return null;
    if (data.outcome !== "ok" && data.outcome !== "warnings" && data.outcome !== "hard_fail") return null;
    const fingerprint = parseFingerprint(data.fingerprint);
    if (!fingerprint) return null;
    const durationSeconds = data.durationSeconds;
    if (durationSeconds !== undefined && (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds))) return null;
    return {
      schema: 1,
      fingerprint,
      trigger: data.trigger,
      outcome: data.outcome,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    };
  } catch {
    return null;
  }
}

/** Missing or malformed last-pass means "no recorded health pass". Never throws. */
export function readSetupHealthPass(ctx: { pacerHome: string }): SetupHealthPassRecord | null {
  let text: string | null;
  try {
    text = readInstallFile(setupHealthPath(ctx));
  } catch {
    return null;
  }
  if (text === null) return null;
  return parseRecord(text);
}

/** Atomic write, mode 0600 — same pattern as owner.json. */
export function writeSetupHealthPass(ctx: { pacerHome: string }, record: Omit<SetupHealthPassRecord, "schema">): void {
  const full: SetupHealthPassRecord = {
    schema: 1,
    fingerprint: {
      ...record.fingerprint,
      schema: 1,
      checkedAt: Math.floor(record.fingerprint.checkedAt),
    },
    trigger: record.trigger,
    outcome: record.outcome,
    ...(record.durationSeconds !== undefined ? { durationSeconds: record.durationSeconds } : {}),
  };
  writeInstallFile(setupHealthPath(ctx), `${JSON.stringify(full, null, 2)}\n`, 0o600);
}
