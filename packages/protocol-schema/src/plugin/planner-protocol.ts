import { z } from "zod";
import type { MethodDef } from "./protocol";

export const PLANNER_INSTALL_FEATURE = "plannerInstallTransactions";
const path = z.string().min(1).max(4096);
const argument = z
  .string()
  .max(4096)
  .refine((value) => !value.includes("\0"));
const argv = z.array(argument).min(1).max(32);
const bytes = z.number().int().nonnegative().safe();
const mode = z
  .number()
  .int()
  .min(0)
  .max(0o700)
  .refine((value) => (value & ~0o700) === 0);
export const plannerCommandIntent = z
  .object({
    argv,
    undo: argv.optional(),
    timeoutMs: z.number().int().positive().max(30000),
  })
  .strict();
const file = z
  .object({
    path,
    before: z.string().nullable(),
    after: z.string().nullable(),
    mode: mode.optional(),
    beforeMode: mode.optional(),
  })
  .strict();
const priorHandle = z
  .object({ handle: z.string().min(1).max(256), bytes })
  .strict();
const env = z
  .object({
    now: z.number().finite(),
    pacerArgv: argv,
    plannerKey: z.string().min(1).max(256),
    mcp: z.boolean().optional(),
    folder: path.optional(),
    plannerAccount: z.string().max(256).optional(),
    configEnv: z.record(z.string(), z.string()).optional(),
    mode: z.enum(["connect", "reconcile"]).optional(),
    skillFolder: path.optional(),
  })
  .strict();
export const plannerInstallParams = z
  .object({
    agent: z.string().min(1).max(64),
    home: path,
    pacerHome: path,
    env,
    binary: path.nullable(),
    prior: z.json().optional(),
    priorRange: priorHandle.optional(),
  })
  .strict();
export const preparedPlannerPlan = z
  .object({
    schema: z.literal(1),
    record: z.json(),
    files: z.array(file).max(512),
    touched: z.array(path).max(512),
    notes: z.array(z.string()).max(512),
    uninstallReport: z
      .object({
        planner: z.string().min(1).max(256),
        restored: z.array(path),
        removed: z.array(path),
        reverted: z.array(path),
        notes: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();
const method = (
  description: string,
  params: z.ZodTypeAny,
  result: z.ZodTypeAny,
  deadlineMs = 5000,
): MethodDef => ({ description, params, result, deadlineMs });
export const PLANNER_METHODS: Record<string, MethodDef> = {
  "planner.install": method(
    "Prepare planner integration data; commands are host-brokered and only the host commits files.",
    plannerInstallParams,
    preparedPlannerPlan,
    120000,
  ),
  "planner.uninstall": method(
    "Prepare bound-record generic file undo and broker provider command removal under a distinct host purpose.",
    plannerInstallParams,
    preparedPlannerPlan,
    120000,
  ),
  "planner.preview": method(
    "Preview selected planner file changes with ordinary read authority and no effects.",
    plannerInstallParams,
    z
      .object({
        files: z.array(path),
        undo: z.string(),
        detail: z.string().optional(),
      })
      .strict(),
  ),
  "planner.plan": method(
    "Preview planner integration without installation effect authority.",
    plannerInstallParams,
    z.json(),
  ),
  "planner.detect": method(
    "Detect planner installation using host-selected resources.",
    z
      .object({
        agent: z.enum(["claude-code", "codex", "cursor", "opencode"]),
        binary: z
          .object({ name: z.string().min(1).max(64), path: path.nullable() })
          .strict()
          .nullable()
          .optional(),
        probe: z
          .object({
            argv,
            timeoutMs: z.literal(5000),
            cwd: path,
            env: z.record(z.string(), z.string()),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z.json(),
  ),
  "planner.check": method(
    "Check host-selected planner integration data without installation effect authority.",
    z
      .object({ agent: z.string().max(64), files: z.array(z.json()).max(512) })
      .strict(),
    z.object({
      intact: z.boolean(),
      files: z.array(z.object({ path, intact: z.boolean() })),
    }),
  ),
};
export const PLANNER_CAPABILITY_METHODS: Record<string, MethodDef> = {
  "capability.planner.run": method(
    "Run one dynamically admitted command under the trusted host install purpose; captures undo before spawn.",
    plannerCommandIntent,
    z.union([
      z.object({
        code: z.number().int(),
        stdout: z.string(),
        stderr: z.string(),
        timedOut: z.boolean(),
      }),
      z.object({
        code: z.number().int(),
        output: z.object({ stdout: z.string(), stderr: z.string() }),
        timedOut: z.boolean(),
      }),
    ]),
    35000,
  ),
  "capability.planner.readPriorRange": method(
    "Read only an owning call's immutable prior-record projection, never a manifest path.",
    z
      .object({
        handle: z.string().min(1).max(256),
        offset: bytes,
        length: bytes.max(262144),
      })
      .strict(),
    z.object({ base64: z.string().max(349528) }),
  ),
};
export const PLANNER_METHOD_CAPABILITY: Record<
  string,
  "process.spawn" | "fs.read"
> = {
  "capability.planner.run": "process.spawn",
  "capability.planner.readPriorRange": "fs.read",
};
