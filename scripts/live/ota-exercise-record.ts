import { z } from "zod";

export const fixtureProcessSchema = z.object({ pid: z.number().int().positive(), bootId: z.string().min(1).max(128), birth: z.string().min(1).max(128) }).strict();
export const MANAGED_SCENARIOS = ["upgrade", "startup-failure", "helper-crash", "interrupted-install", "restore-failure"] as const;
const points = {
  upgrade: [], "startup-failure": ["candidate-startup"], "helper-crash": ["authorized"],
  "interrupted-install": ["installed"], "restore-failure": ["candidate-startup", "restore"],
} as const;
const transaction = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const exerciseSchema = z.object({
  schema: z.literal(1), scenario: z.enum(MANAGED_SCENARIOS), state: z.enum(["armed", "running", "complete", "failed"]),
  driver: fixtureProcessSchema, installationId: z.string().regex(/^[a-f0-9]{64}$/), transactionId: transaction.nullable(),
  faults: z.array(z.object({
    point: z.enum(["authorized", "installed", "restore", "candidate-startup"]),
    consumed: z.object({ process: fixtureProcessSchema, transactionId: transaction }).strict().nullable(),
  }).strict()).max(2),
}).strict().superRefine((value, context) => {
  if (JSON.stringify(value.faults.map(f => f.point)) !== JSON.stringify(points[value.scenario])) context.addIssue({ code: "custom", message: "Faults must match the fixed scenario" });
  let pending = false;
  for (const fault of value.faults) {
    if (fault.consumed === null) pending = true;
    else if (pending || value.transactionId !== fault.consumed.transactionId) context.addIssue({ code: "custom", message: "Fault consumption must match one ordered transaction" });
  }
});
export type OtaExercise = z.infer<typeof exerciseSchema>;
export function newExercise(scenario: string, driver: z.infer<typeof fixtureProcessSchema>, installationId: string): OtaExercise {
  const selected = z.enum(MANAGED_SCENARIOS).parse(scenario);
  return exerciseSchema.parse({ schema: 1, scenario: selected, state: "armed", driver, installationId, transactionId: null, faults: points[selected].map(point => ({ point, consumed: null })) });
}

export const FIXTURE_UPDATE_OPS = ["desktop.update.check", "desktop.update.download", "desktop.update.restart", "desktop.update.cancel", "desktop.update.configure"] as const;
export const runtimeSchema = z.object({
  schema: z.literal(1), driver: fixtureProcessSchema, sourceService: fixtureProcessSchema,
  desktop: fixtureProcessSchema.nullable(), state: z.enum(["starting", "managed", "retired"]),
  request: z.object({ requestId: z.string().min(1).max(128), op: z.enum(FIXTURE_UPDATE_OPS), paramsSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().nullable(),
}).strict();
export type OtaRuntime = z.infer<typeof runtimeSchema>;

/** Only a never-armed baseline with every former driver/desktop exited may resume. */
export function resumableStartup(runtime: OtaRuntime | null, exercise: OtaExercise | null, exited: (identity: z.infer<typeof fixtureProcessSchema>) => boolean): boolean {
  return !!runtime && exercise === null && runtime.state === "starting" && runtime.request === null && runtime.desktop !== null &&
    [runtime.driver, runtime.sourceService, runtime.desktop].every(exited);
}
