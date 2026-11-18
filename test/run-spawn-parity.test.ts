import { expect, test } from "bun:test";
import { join } from "node:path";
import { runnerLogPath, selfCommand } from "../src/tasks/api";
import { fakeCtx } from "./helpers";

/** Mirror `pacer_lifecycle::build_run_spawn_plan` for cross-runtime goldens. */
export function buildRunSpawnPlan(input: {
  execPath: string;
  argv1?: string;
  home: string;
  pacerHome: string;
  baseEnv: Record<string, string>;
  taskId: string;
  admissionLease: string;
}) {
  const scriptArgv = input.argv1 ? [input.execPath, input.argv1, "status"] : [input.execPath, "status"];
  const [cmd, ...pre] = selfCommand(scriptArgv, input.execPath);
  const { PACER_HOST_SOCKET: _owner, ...baseEnv } = input.baseEnv;
  return {
    argv: [...[cmd, ...pre], "_run", input.taskId],
    env: {
      ...baseEnv,
      HOME: input.home,
      PACER_HOME: input.pacerHome,
      PACER_ADMISSION_LEASE: input.admissionLease,
      PACER_ADMISSION_TASK: input.taskId,
    },
    log_path: runnerLogPath({ pacerHome: input.pacerHome }),
    detached: true,
    owner: "typescript_core",
  };
}

const GOLDENS = [
  {
    execPath: "/bun",
    argv1: "/repo/src/cli.ts",
    home: "/home/user",
    pacerHome: "/home/user/.pacer",
    baseEnv: { PATH: "/bin" },
    taskId: "t-20261106-000000-abcd",
    admissionLease: "lease-1",
  },
  {
    execPath: "/usr/local/bin/pacer",
    argv1: "status",
    home: "/home/user",
    pacerHome: "/home/user/.pacer",
    baseEnv: {},
    taskId: "t-20261106-000000-efgh",
    admissionLease: "lease-2",
  },
  {
    // Rust's self_command_matches_typescript_script_detection pins the same embedded case.
    execPath: "/bin/pacer-core",
    argv1: "/$bunfs/root/tasks/supervision-worker.js",
    home: "/home/user",
    pacerHome: "/home/user/.pacer",
    baseEnv: {},
    taskId: "t-20261106-000000-ijkl",
    admissionLease: "lease-3",
  },
  {
    // Rust's plan_drops_the_door_owner_socket pins the same case.
    execPath: "/bin/pacer-core",
    argv1: "status",
    home: "/home",
    pacerHome: "/home/.pacer",
    baseEnv: { PATH: "/bin", PACER_HOST_SOCKET: "/home/.pacer/run/s0123456789ab.sock" },
    taskId: "t-20261106-000000-abcd",
    admissionLease: "lease-1",
  },
] as const;

test("run spawn plan goldens stay aligned with Rust run_spawn", () => {
  const ctx = fakeCtx();
  const dynamic = buildRunSpawnPlan({
    execPath: process.execPath,
    argv1: join(import.meta.dir, "..", "src", "cli.ts"),
    home: ctx.home,
    pacerHome: ctx.pacerHome,
    baseEnv: { PACER_NO_UPDATE_CHECK: "1" },
    taskId: "t-fixture-dynamic",
    admissionLease: "lease-dynamic",
  });
  expect(dynamic.argv.at(-2)).toBe("_run");
  expect(dynamic.env.PACER_HOME).toBe(ctx.pacerHome);
  for (const row of GOLDENS) {
    const plan = buildRunSpawnPlan(row);
    expect(plan.argv[0]).toBe(row.execPath);
    if (row.argv1.startsWith("/$bunfs/")) expect(plan.argv).toEqual([row.execPath, "_run", row.taskId]);
    expect(plan.argv).toContain("_run");
    expect(plan.env.PACER_ADMISSION_TASK).toBe(row.taskId);
    expect(plan.log_path).toBe(join(row.pacerHome, "logs", "runner.log"));
    expect(plan.owner).toBe("typescript_core");
    expect(plan.env).not.toHaveProperty("PACER_HOST_SOCKET");
  }
});
