import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpDir } from "./helpers";
import {
  mainPushRun, mainCiFailures, requireMainCiGreen, TYPECHECK_JOB, RUST_JOBS, LINUX_SHARD_PREFIX,
  MACOS_TEST_JOB, M1_GATE_JOB, M1_GATE_COUNT, type MainCiRun, type MainCiJob,
} from "../scripts/release/main-ci-evidence";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const URL = "https://github.invalid/lamtuanvu/pacer/actions/runs/7";

const greenJobs = (): MainCiJob[] => [
  ...[0, 1, 2, 3, 4, 5, 6, 7].map(shard => ({ name: `${LINUX_SHARD_PREFIX}${shard})`, conclusion: "success" })),
  { name: MACOS_TEST_JOB, conclusion: "success" },
  ...RUST_JOBS.map(name => ({ name, conclusion: "success" })),
  { name: TYPECHECK_JOB, conclusion: "success" },
  ...["macos-latest", "ubuntu-24.04"].map(runner => ({ name: `${M1_GATE_JOB} (${runner})`, conclusion: "success" })),
];

const run = (over: Partial<MainCiRun> = {}): MainCiRun => ({
  id: 7, event: "push", head_branch: "main", head_sha: SHA, status: "completed", conclusion: "success", html_url: URL, ...over,
});

function fake(runs: MainCiRun[], jobs: Record<number, MainCiJob[]> = { 7: greenJobs() }) {
  return { runs: async (sha: string) => runs.filter(item => item.head_sha === sha), jobs: async (id: number) => jobs[id] ?? [] };
}

test("a completed push run on main with every required job green passes", async () => {
  const ci = fake([run()]);
  await expect(requireMainCiGreen(ci, SHA)).resolves.toMatchObject({ id: 7, html_url: URL });
});

test("only the push run on main with the pinned sha counts", () => {
  const runs = [
    run({ id: 1, head_sha: OTHER }), // different commit
    run({ id: 2, event: "workflow_dispatch" }), // not a post-merge push
    run({ id: 3, head_branch: "release/v0.18.0" }), // not main
    run({ id: 4 }),
  ];
  expect(mainPushRun(runs, SHA)).toMatchObject({ id: 4 });
  // Several push runs for one sha: the newest wins.
  expect(mainPushRun([run({ id: 4 }), run({ id: 9, status: "in_progress", conclusion: null })], SHA)).toMatchObject({ id: 9 });
  expect(mainPushRun(runs, OTHER)).toMatchObject({ id: 1 });
  expect(mainPushRun(runs, "c".repeat(40))).toBeUndefined();
});

test("a missing run or a run for another sha refuses with a wait-or-fix message", async () => {
  await expect(requireMainCiGreen(fake([]), SHA)).rejects.toThrow("no CI push run on main for");
  await expect(requireMainCiGreen(fake([run({ head_sha: OTHER })]), SHA)).rejects.toThrow("no CI push run on main");
});

test("an in-progress run refuses without waiting or dispatching", async () => {
  const ci = fake([run({ status: "in_progress", conclusion: null })]);
  await expect(requireMainCiGreen(ci, SHA, () => {})).rejects.toThrow(`still in_progress for ${SHA}: ${URL}`);
});

test("a failed or cancelled run names the run URL and the failing jobs", async () => {
  const ci = fake([run({ conclusion: "failure" })], { 7: [{ name: MACOS_TEST_JOB, conclusion: "failure" }, { name: RUST_JOBS[0]!, conclusion: "cancelled" }] });
  await expect(requireMainCiGreen(ci, SHA, () => {})).rejects.toThrow(`ended failure for ${SHA}: ${URL} (failed: ${MACOS_TEST_JOB}, ${RUST_JOBS[0]})`);
  const cancelled = fake([run({ conclusion: "cancelled" })]);
  await expect(requireMainCiGreen(cancelled, SHA, () => {})).rejects.toThrow("ended cancelled");
});

test("a successful run without the full post-merge suite refuses job by job", async () => {
  const without = (name: string) => greenJobs().filter(job => job.name !== name && !job.name.startsWith(name));
  for (const [missing, patch] of [
    ["shard", { conclusion: "skipped" } as Partial<MainCiJob>],
    [MACOS_TEST_JOB, { conclusion: "skipped" }],
    [RUST_JOBS[1]!, { conclusion: "skipped" }],
    [TYPECHECK_JOB, { conclusion: "skipped" }],
    [M1_GATE_JOB, { conclusion: "skipped" }],
  ] as const) {
    // A skipped or failed required job that is present, or one removed entirely, both fail.
    const present: MainCiJob[] = missing === "shard"
      ? [{ name: `${LINUX_SHARD_PREFIX}0)`, conclusion: patch.conclusion ?? null }]
      : [{ name: missing, conclusion: patch.conclusion ?? null }];
    const jobs = [...without(missing), ...present];
    const problems = mainCiFailures(jobs);
    expect(problems.join("; ")).toContain(missing);
    await expect(requireMainCiGreen(fake([run()], { 7: jobs }), SHA, () => {})).rejects.toThrow(`required checks for ${SHA}: ${URL}`);
  }
});

test("both post-merge M1 gate jobs are required", () => {
  const one = greenJobs().filter(job => !job.name.startsWith(M1_GATE_JOB));
  expect(mainCiFailures([...one, { name: `${M1_GATE_JOB} (macos-latest)`, conclusion: "success" }]).join("; ")).toContain(`1 of ${M1_GATE_COUNT} missing`);
  expect(mainCiFailures(one)).toContain(`${M1_GATE_JOB} (${M1_GATE_COUNT} of ${M1_GATE_COUNT} missing)`);
});

test("the required job names match CI's jobs", () => {
  const ci = Bun.YAML.parse(readFileSync(resolve(".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, any>;
  };
  expect(ci.jobs.checks.name).toBe(TYPECHECK_JOB);
  expect(ci.jobs["macos-tests"].name).toBe(MACOS_TEST_JOB);
  expect(ci.jobs.test.name.replace("${{ matrix.os }}", "ubuntu-latest").replace("${{ matrix.shard }})", "0)")).toBe(`${LINUX_SHARD_PREFIX}0)`);
  expect(ci.jobs.rust.name.replace("${{ matrix.os }}", "x")).toBe("Rust (x)");
  // On push to main, Rust and the M1 gate run on both runners.
  expect(String(ci.jobs.rust.strategy.matrix.os)).toContain('"ubuntu-latest","macos-latest"');
  expect(ci.jobs["m1-gate"].name).toBe(M1_GATE_JOB);
  expect(ci.jobs["m1-gate"].strategy.matrix.include).toHaveLength(M1_GATE_COUNT);
});

test("the CLI exits zero with evidence, and fails with a ::error:: annotation naming the run", () => {
  const dir = tmpDir(), bin = join(dir, "bin");
  mkdirSync(bin);
  const fakeGh = (runs: string, runId = 7, jobs: string = JSON.stringify([{ jobs: greenJobs() }])) =>
    `#!/bin/sh
case "$*" in
  "api repos/fixture/repo/actions/workflows/ci.yml/runs?head_sha=${SHA}&per_page=100") printf '${runs}' ;;
  "api --paginate --slurp repos/fixture/repo/actions/runs/${runId}/jobs?filter=latest&per_page=100") printf '${jobs}' ;;
  *) exit 1 ;;
esac
`;
  const spawn = () => Bun.spawnSync([process.execPath, "scripts/release/main-ci-evidence.ts"], {
    cwd: resolve("."), env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "fixture/repo", MAIN_CI_SHA: SHA },
    stdout: "pipe", stderr: "pipe",
  });
  // Missing environment is refused before any API call.
  const bare = Bun.spawnSync([process.execPath, "scripts/release/main-ci-evidence.ts"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "", MAIN_CI_SHA: "" }, stdout: "pipe", stderr: "pipe",
  });
  expect(bare.exitCode).not.toBe(0);
  expect(bare.stderr.toString()).toContain("::error::GITHUB_REPOSITORY and MAIN_CI_SHA are required");

  writeFileSync(join(bin, "gh"), fakeGh(JSON.stringify({ workflow_runs: [] })), { mode: 0o755 });
  const missing = spawn();
  expect(missing.exitCode).not.toBe(0);
  expect(missing.stderr.toString()).toContain("::error::no CI push run on main for");

  writeFileSync(join(bin, "gh"), fakeGh(JSON.stringify({ workflow_runs: [run()] })), { mode: 0o755 });
  const passed = spawn();
  expect(passed.exitCode).toBe(0);
  expect(passed.stdout.toString()).toContain(`main's post-merge CI passed for ${SHA}: ${URL}`);

  writeFileSync(join(bin, "gh"), fakeGh(JSON.stringify({ workflow_runs: [run({ conclusion: "failure" })] }), 7, JSON.stringify([{ jobs: [{ name: MACOS_TEST_JOB, conclusion: "failure" }] }])), { mode: 0o755 });
  const refused = spawn();
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stderr.toString()).toContain(`::error::main's post-merge CI ended failure for ${SHA}: ${URL} (failed: ${MACOS_TEST_JOB})`);
});
