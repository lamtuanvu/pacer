import { z } from "zod";

/** Caps for one `workflow.definitions` page (transport line is 1 MiB; reply stays under 960 KiB). */
export const WORKFLOW_SOURCE_MAX_BYTES = 256 * 1024;
export const WORKFLOW_PROMPT_MAX_BYTES = 64 * 1024;
export const WORKFLOW_DEFINITIONS_REPLY_MAX_BYTES = 960 * 1024;
export const WORKFLOW_DEFINITIONS_DEADLINE_MS = 10_000;
/** At most one workflow per page. */
export const WORKFLOW_DEFINITIONS_PAGE_SIZE = 1;

const workflowName = z.string().min(1).max(64).regex(
  /^[a-z0-9][a-z0-9_-]*$/,
  "workflow name is lowercase letters, digits, hyphens and underscores",
);

/** `contributes.workflow`: declared names this plugin may serve via `workflow.definitions`. */
export const workflowContribution = z.record(
  workflowName,
  z.object({ title: z.string().min(1).max(128).optional() }).strict(),
);

export const workflowDefinitionEntry = z.object({
  name: workflowName,
  version: z.number().int().min(1).safe(),
  source: z.string().min(1).max(WORKFLOW_SOURCE_MAX_BYTES),
  prompts: z.record(z.string().min(1).max(512), z.string().max(WORKFLOW_PROMPT_MAX_BYTES)),
}).strict();

export const workflowDefinitionsParams = z.object({
  after: z.string().min(1).max(256).optional(),
}).strict();

export const workflowDefinitionsResult = z.object({
  workflows: z.array(workflowDefinitionEntry).max(WORKFLOW_DEFINITIONS_PAGE_SIZE),
  next: z.string().min(1).max(256).optional(),
}).strict();

export type WorkflowContribution = z.infer<typeof workflowContribution>;
export type WorkflowDefinitionsParams = z.infer<typeof workflowDefinitionsParams>;
export type WorkflowDefinitionsResult = z.infer<typeof workflowDefinitionsResult>;

/** UTF-8 size of a JSON-RPC result envelope for one reply (matches host line framing). */
export function workflowDefinitionsReplyBytes(result: unknown): number {
  return Buffer.byteLength(`${JSON.stringify({ jsonrpc: "2.0", id: 0, result })}\n`, "utf8");
}

/** Whether a validated (or raw) definitions reply fits the 960 KiB host cap. */
export function workflowDefinitionsReplyFits(result: unknown): boolean {
  try {
    return workflowDefinitionsReplyBytes(result) <= WORKFLOW_DEFINITIONS_REPLY_MAX_BYTES;
  } catch {
    return false;
  }
}

export const WORKFLOW_METHODS = {
  "workflow.definitions": {
    description:
      "Return one page of workflow definitions this plugin contributes (at most one workflow with its prompts). Pure data: no capability grant. Pass `after` from a previous `next` to continue. Each source is ≤256 KiB, each prompt ≤64 KiB, and the whole reply must stay under 960 KiB.",
    params: workflowDefinitionsParams,
    result: workflowDefinitionsResult,
    deadlineMs: WORKFLOW_DEFINITIONS_DEADLINE_MS,
  },
} as const;
