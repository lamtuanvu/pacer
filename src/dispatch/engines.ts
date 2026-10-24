import { createHash } from "node:crypto";
import { z } from "zod";
import { CoreError } from "../core/errors";
import { decisionRequestSchema, proposalSchema, type DecisionRequest, type DispatchPreview } from "./types";
import { evaluateLadder } from "./ladder";

export interface DecisionEngine {
  readonly id: string;
  readonly version: string;
  readonly optionsSchema?: z.ZodType;
  decide(request: DecisionRequest, signal: AbortSignal): Promise<unknown>;
}
export const ladderEngine: DecisionEngine = {
  id: "ladder", version: "1", optionsSchema: z.object({}).strict(),
  async decide(request) { return evaluateLadder(request, request.config); },
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const decisionHash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
function freeze(value: object): void {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
}

/** A proposal is never an admission or launch. Malformed engine output is retained only as a fixed validation outcome. */
export async function runDecision(input: DecisionRequest, engine: DecisionEngine): Promise<DispatchPreview> {
  if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024) throw new CoreError("too_large", "Decision input exceeds 256 KiB");
  const parsed = decisionRequestSchema.safeParse(input);
  if (!parsed.success) throw new CoreError("invalid_input", "Invalid decision request");
  const request = parsed.data;
  if (new Set(request.candidates.map(c => c.id)).size !== request.candidates.length) throw new CoreError("invalid_input", "Duplicate candidate IDs");
  freeze(request);
  const result: DispatchPreview = {
    schemaVersion: 1, engine: { id: engine.id, version: engine.version }, request,
    inputHash: decisionHash(request), proposal: null, outputHash: null, validation: "invalid",
    recommendedAction: request.config.onNoMatch, excluded: [], uncertainty: [],
  };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const duration = Math.min(request.config.timeoutMs, (request.deadline - request.now) * 1000);
  if (duration <= 0) return { ...result, validation: "timeout" };
  try {
    const output = await Promise.race([
      Promise.resolve().then(() => engine.decide(request, controller.signal)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("timeout")); }, duration); }),
    ]);
    if (Buffer.byteLength(JSON.stringify(output) ?? "") > 256 * 1024) return result;
    const proposal = proposalSchema.safeParse(output);
    if (!proposal.success) return result;
    if (proposal.data.state === "ranked") {
      const ids = proposal.data.choices.map(c => c.id);
      if (new Set(ids).size !== ids.length || ids.some(id => !request.candidates.some(c => c.id === id))) return result;
    }
    return { ...result, proposal: proposal.data, outputHash: decisionHash(proposal.data), validation: "valid", recommendedAction: proposal.data.state === "ranked" ? "select" : request.config.onNoMatch };
  } catch { return { ...result, validation: controller.signal.aborted ? "timeout" : "invalid" }; }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}
