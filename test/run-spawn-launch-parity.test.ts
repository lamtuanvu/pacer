import { expect, test } from "bun:test";
import { join } from "node:path";
import { runnerLogPath } from "../src/tasks/api";
import { buildRunSpawnPlan } from "./run-spawn-parity.test";

/** Mirror `pacer_lifecycle::resolve_launch_admission_lease`. */
export function resolveLaunchAdmissionLease(
  baseEnv: Record<string, string>,
  taskId: string,
  admittedLease?: string,
): string | undefined {
  if (admittedLease !== undefined) return admittedLease;
  if (baseEnv.PACER_ADMISSION_TASK === taskId) return baseEnv.PACER_ADMISSION_LEASE;
  return undefined;
}

/** Mirror `launchTaskRunner` env pins before work-sync allocation. */
export function buildRunSpawnPlanForLaunch(input: {
  execPath: string;
  argv1?: string;
  home: string;
  pacerHome: string;
  baseEnv: Record<string, string>;
  taskId: string;
  admittedLease?: string;
}) {
  const lease = resolveLaunchAdmissionLease(
    input.baseEnv,
    input.taskId,
    input.admittedLease,
  );
  if (!lease) throw new Error("run spawn missing admission lease");
  return buildRunSpawnPlan({ ...input, admissionLease: lease });
}

const LEASE_GOLDENS = [
  {
    baseEnv: { PACER_ADMISSION_TASK: "t-a", PACER_ADMISSION_LEASE: "inherited" },
    taskId: "t-a",
    admittedLease: undefined,
    expected: "inherited",
  },
  {
    baseEnv: { PACER_ADMISSION_TASK: "t-a", PACER_ADMISSION_LEASE: "inherited" },
    taskId: "t-b",
    admittedLease: undefined,
    expected: undefined,
  },
  {
    baseEnv: { PACER_ADMISSION_TASK: "t-a", PACER_ADMISSION_LEASE: "inherited" },
    taskId: "t-a",
    admittedLease: "explicit",
    expected: "explicit",
  },
] as const;

test("run spawn launch lease resolution stays aligned with Rust run_spawn", () => {
  for (const row of LEASE_GOLDENS) {
    expect(
      resolveLaunchAdmissionLease(row.baseEnv, row.taskId, row.admittedLease),
    ).toBe(row.expected);
  }
  const plan = buildRunSpawnPlanForLaunch({
    execPath: "/bun",
    argv1: join(import.meta.dir, "..", "src", "cli.ts"),
    home: "/home/user",
    pacerHome: "/home/user/.pacer",
    baseEnv: { PATH: "/bin" },
    taskId: "t-20261106-000000-abcd",
    admittedLease: "lease-explicit",
  });
  expect(plan.env.PACER_ADMISSION_LEASE).toBe("lease-explicit");
  const inherited = buildRunSpawnPlanForLaunch({
    execPath: "/bun",
    argv1: "/repo/src/cli.ts",
    home: "/home/user",
    pacerHome: "/home/user/.pacer",
    baseEnv: {
      PACER_ADMISSION_TASK: "t-20261106-000000-abcd",
      PACER_ADMISSION_LEASE: "lease-inherited",
    },
    taskId: "t-20261106-000000-abcd",
  });
  expect(inherited.env.PACER_ADMISSION_LEASE).toBe("lease-inherited");
  expect(plan.argv.at(-2)).toBe("_run");
  expect(plan.argv.at(-1)).toBe("t-20261106-000000-abcd");
  expect(plan.log_path).toBe(runnerLogPath({ pacerHome: "/home/user/.pacer" }));
  expect(() =>
    buildRunSpawnPlanForLaunch({
      execPath: "/bun",
      argv1: "/repo/src/cli.ts",
      home: "/home/user",
      pacerHome: "/home/user/.pacer",
      baseEnv: {},
      taskId: "t-20261106-000000-abcd",
    }),
  ).toThrow("run spawn missing admission lease");
});
