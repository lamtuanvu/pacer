import { expect, test } from "bun:test";
import { awaitCiEvidence, fullSuitePassed, SUITE_JOBS, SUITE_STEP, type Ci, type CiJob, type CiRun } from "../scripts/release/ci-evidence";

const SHA = "a".repeat(40);
const suite = (conclusion: string | null = "success", skip?: string): CiJob[] =>
  SUITE_JOBS.filter(name => name !== skip).map(name => ({ name, steps: [{ name: "Set up job", conclusion: "success" }, { name: SUITE_STEP, conclusion }] }));
const ciRun = (id: number, event: string, status = "completed", created = 0): CiRun =>
  ({ id, event, status, conclusion: status === "completed" ? "success" : null, created_at: new Date(created).toISOString(), html_url: `run/${id}` });

function fake(script: (tick: number, dispatched: number | undefined) => CiRun[], jobs: Record<number, CiJob[]>) {
  let clock = 0, tick = 0, dispatched: number | undefined;
  const refs: string[] = [];
  const ci: Ci = {
    runs: async () => script(tick, dispatched),
    jobs: async id => jobs[id] ?? [],
    dispatch: async ref => { refs.push(ref); dispatched = clock; },
    sleep: async ms => { clock += ms; tick++; },
    now: () => clock,
  };
  return { ci, refs };
}

test("only an executed, passing suite step on all eight shards counts", () => {
  expect(SUITE_JOBS).toHaveLength(8);
  expect(fullSuitePassed(suite())).toBe(true);
  expect(fullSuitePassed(suite("skipped"))).toBe(false);
  expect(fullSuitePassed(suite("failure"))).toBe(false);
  expect(fullSuitePassed(suite("success", "Test (macos-latest, shard 3)"))).toBe(false);
});

test("an existing passing run is reused without dispatching", async () => {
  const { ci, refs } = fake(() => [ciRun(2, "push")], { 2: suite() });
  expect((await awaitCiEvidence(ci, SHA, "main", 1e9, () => {})).id).toBe(2);
  expect(refs).toEqual([]);
});

test("pull request runs never count, even with a passing suite", async () => {
  const { ci, refs } = fake((_, d) => d === undefined ? [ciRun(1, "pull_request")] : [ciRun(1, "pull_request"), ciRun(3, "workflow_dispatch", "completed", d)], { 1: suite(), 3: suite() });
  expect((await awaitCiEvidence(ci, SHA, "release/v1.2.3", 1e9, () => {})).id).toBe(3);
  expect(refs).toEqual(["release/v1.2.3"]);
});

test("an in-progress run is awaited instead of dispatching another", async () => {
  const { ci, refs } = fake(tick => [ciRun(4, "push", tick < 3 ? "in_progress" : "completed")], { 4: suite() });
  expect((await awaitCiEvidence(ci, SHA, "main", 1e9, () => {})).id).toBe(4);
  expect(refs).toEqual([]);
});

test("a path-filtered run leads to one dispatch on the release ref", async () => {
  const { ci, refs } = fake((tick, d) => d === undefined ? [ciRun(5, "push")] : [ciRun(5, "push"), ciRun(6, "workflow_dispatch", tick < 4 ? "queued" : "completed", d)], { 5: suite("skipped"), 6: suite() });
  expect((await awaitCiEvidence(ci, SHA, "v1.2.3", 1e9, () => {})).id).toBe(6);
  expect(refs).toEqual(["v1.2.3"]);
});

test("a failing dispatched run fails the gate without dispatching again", async () => {
  const { ci, refs } = fake((_, d) => d === undefined ? [] : [ciRun(7, "workflow_dispatch", "completed", d)], { 7: suite("failure") });
  await expect(awaitCiEvidence(ci, SHA, "release/recovery-v1.2.3-abc", 1e9, () => {})).rejects.toThrow("finished without a passing full suite");
  expect(refs).toHaveLength(1);
});

test("a rerun of a checked run is examined again", async () => {
  const { ci, refs } = fake(tick => [ciRun(8, "push", tick === 1 ? "in_progress" : "completed")], {});
  let attempt = 0;
  ci.jobs = async () => (attempt++ === 0 ? suite("failure") : suite());
  expect((await awaitCiEvidence(ci, SHA, "main", 1e9, () => {})).id).toBe(8);
  expect(attempt).toBe(2);
  expect(refs).toEqual(["main"]);
});

test("waiting is bounded by the deadline", async () => {
  const { ci } = fake(() => [ciRun(9, "push", "in_progress")], {});
  await expect(awaitCiEvidence(ci, SHA, "main", 120_000, () => {})).rejects.toThrow("Timed out");
});
