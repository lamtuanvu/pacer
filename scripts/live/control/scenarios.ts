import { z } from "zod";
import { requestSchema, type ControlRequest, type ControlResult } from "./contract";
export const scenarioSchema = z.object({
  schema_version: z.literal(1), name: z.string().min(1).max(128),
  steps: z.array(requestSchema).min(1).max(100),
}).strict();
export type Scenario = z.input<typeof scenarioSchema>;
export interface ScenarioResult { schema_version: 1; name: string; verdict: "PASS" | "FAIL" | "UNVERIFIED"; results: ControlResult[] }
export async function runScenario(input: Scenario, execute: (request: ControlRequest) => Promise<ControlResult>): Promise<ScenarioResult> {
  const scenario = scenarioSchema.parse(input);
  const summary: ScenarioResult = { schema_version: 1, name: scenario.name, verdict: "UNVERIFIED", results: [] };
  let assertions = 0;
  for (const request of scenario.steps) {
    const result = await execute(request);
    summary.results.push(result);
    if (result.verdict === "FAIL") { summary.verdict = "FAIL"; return summary; }
    if (result.outcome !== "ok" || result.verdict === "UNVERIFIED") return summary;
    if (result.verdict === "PASS") assertions++;
  }
  if (assertions > 0) summary.verdict = "PASS";
  return summary;
}
