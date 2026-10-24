import { dispatchConfigSchema, type DecisionRequest, type Candidate } from "../../src/dispatch/types";
export function candidate(id: string, headroom: number | null = 50): Candidate {
  return { id, runner: id, account: "shared", executor: "codex", binding: { kind: "exact", id: `provider/${id}` }, actualModel: null, tier: "medium", strengths: ["coding"], tools: true, context: 10000, provenance: "declared", poolIds: ["shared-pool"], headroom, burn: 1, cost: null, capacityKnown: headroom !== null };
}
export function request(candidates: Candidate[] = [candidate("a"), candidate("b", 10)]): DecisionRequest {
  const now = Date.now() / 1000;
  return { schemaVersion: 1, requestId: "test", now, deadline: now + 1, task: { kind: null, requirements: {}, preferences: { models: [], strengths: [] }, provenance: "request" }, candidates, observations: [], observationRevision: "rev", strategyHash: "hash", config: dispatchConfigSchema.parse({}) };
}
