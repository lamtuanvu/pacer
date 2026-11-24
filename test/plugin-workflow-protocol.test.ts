import { expect, test } from "bun:test";
import {
  EXTENSION_METHODS, EXTENSION_POINTS, PLUGIN_PROTOCOL_VERSION, manifestSchema,
  workflowDefinitionsParams, workflowDefinitionsResult, workflowDefinitionsReplyFits,
  WORKFLOW_DEFINITIONS_REPLY_MAX_BYTES, WORKFLOW_DEFINITIONS_DEADLINE_MS,
} from "../src/plugins/protocol";

const base = {
  id: "fx-wf", version: "1.0.0", publisher: "test", host: ">=1.12.0",
  contributes: { workflow: { feature: { title: "Feature" } } },
};

test("workflow extension point and definitions method ship in 1.12.0", () => {
  expect(PLUGIN_PROTOCOL_VERSION).toBe("1.12.0");
  expect(EXTENSION_POINTS).toContain("workflow");
  expect(EXTENSION_METHODS["workflow.definitions"]?.deadlineMs).toBe(WORKFLOW_DEFINITIONS_DEADLINE_MS);
  expect(workflowDefinitionsParams.safeParse({}).success).toBe(true);
  expect(workflowDefinitionsParams.safeParse({ after: "feature@1" }).success).toBe(true);
});

test("workflow.definitions schema round-trips one page", () => {
  const page = {
    workflows: [{
      name: "feature",
      version: 1,
      source: "id: fx-wf/feature\nversion: 1\nsteps:\n  done: { type: end }\nedges: []\n",
      prompts: { "prompts/start.md": "Start the work." },
    }],
    next: "router@1",
  };
  const parsed = workflowDefinitionsResult.safeParse(page);
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data).toEqual(page);
  expect(workflowDefinitionsResult.safeParse({
    workflows: [page.workflows[0], page.workflows[0]],
  }).success).toBe(false);
  expect(workflowDefinitionsResult.safeParse({
    workflows: [{ ...page.workflows[0]!, version: 0 }],
  }).success).toBe(false);
});

test("a workflow.definitions reply over 960 KiB is refused", () => {
  const huge = "x".repeat(700_000);
  const result = {
    workflows: [{ name: "feature", version: 1, source: huge.slice(0, 256 * 1024), prompts: { a: huge.slice(0, 64 * 1024), b: huge.slice(0, 64 * 1024), c: huge.slice(0, 64 * 1024), d: huge.slice(0, 64 * 1024), e: huge.slice(0, 64 * 1024), f: huge.slice(0, 64 * 1024), g: huge.slice(0, 64 * 1024), h: huge.slice(0, 64 * 1024), i: huge.slice(0, 64 * 1024), j: huge.slice(0, 64 * 1024), k: huge.slice(0, 64 * 1024), l: huge.slice(0, 64 * 1024), m: huge.slice(0, 64 * 1024), n: huge.slice(0, 64 * 1024), o: huge.slice(0, 64 * 1024) } }],
  };
  // Field caps alone can still exceed 960 KiB when many prompts fill; the host size gate refuses.
  expect(workflowDefinitionsReplyFits(result)).toBe(false);
  expect(WORKFLOW_DEFINITIONS_REPLY_MAX_BYTES).toBe(960 * 1024);
  expect(workflowDefinitionsReplyFits({
    workflows: [{ name: "feature", version: 1, source: "id: a\nversion: 1\nsteps: { done: { type: end } }\nedges: []\n", prompts: {} }],
  })).toBe(true);
});

test("a manifest with contributes.workflow needs host >=1.12.0", () => {
  expect(manifestSchema.safeParse({ ...base, host: ">=1.11.0" }).success).toBe(false);
  expect(manifestSchema.safeParse({ ...base, host: "^1.11" }).success).toBe(false);
  expect(manifestSchema.safeParse(base).success).toBe(true);
  expect(manifestSchema.safeParse({ ...base, host: ">=1.12.0" }).success).toBe(true);
  const err = manifestSchema.safeParse({ ...base, host: ">=1.11.0" });
  expect(err.success).toBe(false);
  if (!err.success) expect(err.error.issues.some(i => /contributes\.workflow sets host to >=1\.12\.0/.test(i.message))).toBe(true);
});
