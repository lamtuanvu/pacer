import type { Handler } from "./index";

/** One page of `workflow.definitions` (host >= 1.12.0). At most one workflow per reply. */
export interface WorkflowDefinitionsParams {
  after?: string;
}

export interface WorkflowDefinitionEntry {
  name: string;
  version: number;
  source: string;
  prompts: Record<string, string>;
}

export interface WorkflowDefinitionsResult {
  workflows: WorkflowDefinitionEntry[];
  next?: string;
}

export type WorkflowDefinitionsHandler = (
  params: WorkflowDefinitionsParams,
  signal: AbortSignal,
) => WorkflowDefinitionsResult | Promise<WorkflowDefinitionsResult>;

/** Typed `workflow.definitions` handler. Spread into `handlers`; the manifest contributes `workflow`. */
export function workflowDefinitions(
  handler: WorkflowDefinitionsHandler,
): Record<"workflow.definitions", Handler> {
  return {
    "workflow.definitions": (params, _host, signal) =>
      handler(params as WorkflowDefinitionsParams, signal),
  };
}
