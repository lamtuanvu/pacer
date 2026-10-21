import type { Condition, Observation } from "./contract";
export interface AssertionResult { verdict: "PASS" | "FAIL" | "UNVERIFIED"; expected: Condition; actual: string }
export function evaluateCondition(observation: Observation, condition: Condition): AssertionResult {
  const matches = observation.elements.filter(element => (condition.role === undefined || element.role === condition.role) &&
    (condition.name === undefined || element.name === condition.name) && (condition.value === undefined || element.value === condition.value) &&
    (condition.focused === undefined || element.focused === condition.focused));
  let found = matches.length > 0;
  const actual = observation.text ?? observation.elements.map(element => `${element.name} ${element.value ?? ""}`).join("\n");
  if (condition.text !== undefined) found = (condition.role !== undefined || condition.name !== undefined || condition.value !== undefined || condition.focused !== undefined)
    ? matches.some(element => `${element.name} ${element.value ?? ""}`.includes(condition.text!)) : actual.includes(condition.text);
  if (observation.truncated && (!found || condition.absent)) return { verdict: "UNVERIFIED", expected: condition, actual: "observation truncated" };
  return { verdict: (condition.absent ? !found : found) ? "PASS" : "FAIL", expected: condition, actual };
}
