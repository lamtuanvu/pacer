import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { benchmarkBranch, benchmarkLimitations, benchmarkRef, benchmarkRepository, benchmarkWorkflowPath, platforms, requiredJobs, variants } from "../scripts/release/experiment-benchmark";

const path = benchmarkWorkflowPath;
const text = () => readFileSync(path, "utf8");
const workflow = () => parse(text());
const guard = `github.repository == '${benchmarkRepository}' && github.event_name == 'push' && github.ref == '${benchmarkRef}'`;
const actionsOf = (jobs: Record<string, any>) => (Object.values(jobs) as any[]).flatMap(job => job.steps ?? []);

test("benchmark workflow exists and replaces the dispatch-only experiment files", () => {
  expect(existsSync(path)).toBe(true);
  expect(existsSync(".github/workflows/release-experiment.yml")).toBe(false);
  expect(existsSync(".github/workflows/release-experiment-full.yml")).toBe(false);
});

test("triggers solely on a push to the exact temporary benchmark branch", () => {
  expect(workflow().on).toEqual({ push: { branches: [benchmarkBranch] } });
  // A literal filter: no glob can widen the match, and it is never a production branch.
  expect(benchmarkBranch).toMatch(/^benchmark\/[a-z0-9-]+$/);
  expect(benchmarkBranch).not.toMatch(/[*?[\]!+]/);
  expect(["main", "master", "release", "develop"]).not.toContain(benchmarkBranch);
  expect(benchmarkRef).toBe(`refs/heads/${benchmarkBranch}`);
  expect(text()).not.toMatch(/^\s*(workflow_dispatch|schedule|pull_request|pull_request_target|workflow_run|workflow_call|repository_dispatch|release|tags|tags-ignore|branches-ignore|paths|paths-ignore)\s*:/m);
});

test("every job is hard-gated on repository, push event and exact ref", () => {
  const jobs = workflow().jobs;
  for (const [id, job] of Object.entries(jobs) as [string, any][]) {
    expect(job.if).toBe(id === "report" ? `\${{ always() && ${guard} }}` : `\${{ ${guard} }}`);
  }
  // Only the reporter may run after a failure, and only within the same guard.
  expect(text().match(/always\(\)/g)).toHaveLength(2);
});

test("read-only token, no secrets, caches, environments or external writes", () => {
  const parsed = workflow(), jobs = parsed.jobs;
  expect(parsed.permissions).toEqual({ contents: "read", actions: "read" });
  expect(parsed.concurrency).toBeUndefined(); // every trial and its queue time stay observable
  for (const job of Object.values(jobs) as any[]) {
    expect(job.permissions).toBeUndefined();
    expect(job.environment).toBeUndefined();
    expect(job.services).toBeUndefined();
    expect(job.container).toBeUndefined();
  }
  for (const step of actionsOf(jobs)) {
    if (!step.uses) continue;
    expect(step.uses).toMatch(/^(actions\/(checkout|upload-artifact|download-artifact)|oven-sh\/setup-bun)@[a-f0-9]{40}$/);
    if (step.uses.startsWith("actions/checkout@")) {
      expect(step.with.ref).toBe("${{ github.sha }}");
      expect(step.with["persist-credentials"]).toBe(false);
    }
    if (step.uses.startsWith("oven-sh/setup-bun@")) expect(step.with["no-cache"]).toBe(true);
    if (step.uses.startsWith("actions/download-artifact@")) {
      // Current run only: never another run, repository or token.
      expect(step.with["run-id"]).toBeUndefined();
      expect(step.with.repository).toBeUndefined();
      expect(step.with["github-token"]).toBeUndefined();
    }
  }
  expect(text()).not.toMatch(/secrets\.|vars\.|contents: write|id-token: write|attestations: write|packages: write|actions\/cache|Swatinem|sccache|cache-from|gh release|gh workflow|gh api|git tag|git push|npm publish|publish|notarytool|codesign |import-certificate|APPLE_|TAURI_SIGNING|GPG/);
});

test("experiment DAG has independent target handoffs and an always-running reporter", () => {
  const jobs = workflow().jobs;
  expect(Object.keys(jobs).sort()).toEqual([...requiredJobs, "report"].sort());
  expect(jobs.candidate.needs).toBeUndefined();
  expect(jobs.focused.needs).toEqual(["candidate"]);
  for (const p of platforms) {
    const cli = `cli-${p.platform}`, desktop = `desktop-${p.platform}`;
    expect(jobs[cli].needs).toEqual(["candidate"]);
    expect(jobs[desktop].needs).toEqual(["candidate", cli]);
    expect(jobs[cli]["runs-on"]).toBe(p.runner);
    expect(jobs[desktop]["runs-on"]).toBe(p.runner);
    expect(jobs[cli].env.PLATFORM).toBe(p.platform);
    expect(jobs[desktop].env.TARGET).toBe(p.target);
    expect(jobs[desktop].env.BUNDLES).toBe(p.bundles);
    const download = jobs[desktop].steps.find((s: any) => s.name === "Download matching CLI handoff");
    expect(download.with["artifact-ids"]).toBe(`\${{ needs.${cli}.outputs.artifact }}`);
  }
  for (const config of variants) {
    expect(readFileSync("rust-toolchain.toml", "utf8")).toContain(`channel = "${config.rust}"`);
    expect(readFileSync("desktop/src-tauri/rust-toolchain.toml", "utf8")).toContain(`channel = "${config.rust}"`);
    expect(jobs[config.id].steps.find((s: any) => s.uses?.startsWith("oven-sh/setup-bun@")).with["bun-version"]).toBe(config.bun);
  }
  expect(jobs.promotion.needs.slice().sort()).toEqual(requiredJobs.filter(j => j !== "promotion").sort());
  expect(jobs.report.needs.slice().sort()).toEqual(requiredJobs.slice().sort());
  // All edges resolve, and no cycle can be hidden in a syntactically valid YAML file.
  const active = new Set<string>(), done = new Set<string>();
  function visit(id: string) {
    expect(jobs[id]).toBeDefined();
    expect(active.has(id)).toBe(false);
    if (done.has(id)) return;
    active.add(id);
    for (const parent of jobs[id].needs ?? []) visit(parent);
    active.delete(id); done.add(id);
  }
  for (const id of Object.keys(jobs)) visit(id);
});

test("focused security and release checks stay on the benchmark path", () => {
  const jobs = workflow().jobs;
  const focused = jobs.focused.steps.map((s: any) => s.run ?? "").join("\n");
  for (const file of ["release-experiment-identity", "release-experiment-benchmark", "release-experiment", "release-experiment-workflow", "release-experiment-artifacts",
    "release-pair-build", "release-pair-packages", "release-pair-orchestration", "desktop-release-build", "desktop-release-workflow", "release-workflow"]) {
    expect(focused).toContain(`test/${file}.test.ts`);
    expect(existsSync(`test/${file}.test.ts`)).toBe(true);
  }
  expect(focused).toContain("bun run typecheck");
  for (const p of platforms) {
    const cli = jobs[`cli-${p.platform}`].steps.map((s: any) => s.run ?? "").join("\n");
    const desktop = jobs[`desktop-${p.platform}`].steps.map((s: any) => s.run ?? "").join("\n");
    expect(cli).toContain("experiment.ts prepare-cli");
    expect(desktop).toContain("experiment.ts verify");
    expect(desktop).toContain("experiment.ts seal");
    expect(desktop).toContain("experiment.ts smoke-desktop");
    // Linux bundles go through the production repacking script, which itself builds with --no-sign.
    if (p.platform.startsWith("linux-")) {
      expect(desktop).toContain("desktop/scripts/build-linux-bundles.sh");
      expect(readFileSync("desktop/scripts/build-linux-bundles.sh", "utf8").match(/tauri build .*--no-sign/g)).toHaveLength(2);
    } else expect(desktop).toContain("--no-sign");
    if (p.platform.startsWith("darwin-")) expect(cli).toContain("security find-identity");
  }
  expect(jobs.promotion.steps.some((s: any) => s.run === "bun scripts/release/experiment.ts promote")).toBe(true);
  expect(jobs.candidate.steps.some((s: any) => s.run === "bun scripts/release/experiment.ts candidate")).toBe(true);
  expect(jobs.report.steps.some((s: any) => s.run === "bun scripts/release/experiment.ts report")).toBe(true);
});

test("production workflows are untouched by and unaware of the benchmark", () => {
  for (const file of readdirSync(".github/workflows").filter(f => `.github/workflows/${f}` !== path)) {
    const content = readFileSync(`.github/workflows/${file}`, "utf8");
    expect(content).not.toContain(benchmarkBranch);
    expect(content).not.toContain("scripts/release/experiment");
    expect(content).not.toContain("release-build-benchmark");
  }
  // Full validation remains in existing CI, outside the benchmark's critical path.
  const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  expect(ci.on).toHaveProperty("workflow_dispatch");
  expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain("bun run test");
});

test("workflow and documentation state the lower-bound limitations explicitly", () => {
  expect(text()).toMatch(/LOWER-BOUND/);
  expect(text()).toMatch(/Not a release and not a 30-minute\n# release result/);
  expect(workflow().name).toContain("not a release");
  const doc = readFileSync("docs/testing/release-build-benchmark.md", "utf8").replace(/\s+/g, " ");
  expect(doc).toContain(benchmarkBranch);
  expect(doc).toContain("not a 30-minute release result");
  for (const limitation of benchmarkLimitations) expect(doc).toContain(limitation);
});
