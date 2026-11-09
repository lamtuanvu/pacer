import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function select(paths: string[]) {
  const run = Bun.spawnSync(["python3", "scripts/ci/changes.py", "--paths-json", JSON.stringify(paths)]);
  expect(run.exitCode).toBe(0);
  return JSON.parse(run.stdout.toString()) as Record<string, boolean> & { focused_tests: string[] };
}

test("docs and portable skills avoid compiler/browser jobs", () => {
  expect(select([".project/rules/ui.md", ".agents/skills/project-review/SKILL.md", "docs/accounts.md"]))
    .toMatchObject({ bun: false, rust: false, e2e: false, ui: false, codeql: false });
});

test("UI changes retain browser e2e and evidence without the Rust workspace", () => {
  expect(select(["app/src/app.tsx"]))
    .toMatchObject({ bun: true, rust: false, e2e: true, ui: true, codeql: true });
});

test("Rust changes retain conformance and Bun coverage", () => {
  expect(select(["crates/server/src/lib.rs"]))
    .toMatchObject({ bun: true, rust: true, e2e: true, ui: false });
});

test("core integration changes run both languages and e2e", () => {
  expect(select(["src/serve/http.ts"]))
    .toMatchObject({ bun: true, rust: true, e2e: true, codeql: true });
});

test("shared inputs, CI and unknown paths select full validation", () => {
  for (const path of ["bun.lock", "package.json", "new-runtime/file.xyz"]) {
    expect(select([path])).toMatchObject({ bun: true, rust: true, e2e: true, ui: true, codeql: true });
  }
});


test("mapped workflow changes use focused tests; mixed and unknown changes fail closed", () => {
  expect(select([".github/workflows/ci.yml"])).toMatchObject({ bun: true, rust: false, e2e: false, full: false });
  expect(select([".github/workflows/ci.yml", "new-runtime/file.xyz"])).toMatchObject({ full: true, rust: true, e2e: true });
  expect(select([".github/workflows/new.yml"])).toMatchObject({ full: true, rust: true });
});

test("audited source mapping includes direct and transitive tests and keeps integration checks", () => {
  const path = "src/classify/metrics.ts";
  expect(select([path])).toMatchObject({ bun: true, rust: true, e2e: true, codeql: true,
    full: false, focused_tests: ["test/bench-metrics.test.ts", "test/bench.test.ts"] });
  for (const other of ["src/classify/bench.ts", "src/classify/types.ts", "test/bench.test.ts",
    "src/unknown.ts", "docs/protocol.md", "docs/testing/ci-selection.md", ".github/workflows/ci.yml"]) {
    expect(select([path, other])).toMatchObject({ full: true });
  }
  expect(select(["src/classify/types.ts"])).toMatchObject({ full: true });
});

test("audited leaf mappings select every direct test and union multiple changes", () => {
  const mappings: Record<string, string[]> = {
    "src/console/cli.ts": ["test/autoconsole-worker.test.ts", "test/console-cli.test.ts"],
    "src/console/console.ts": ["test/api-cmd.test.ts", "test/console-settings.test.ts"],
    "src/usage/cache.ts": ["test/cache.test.ts", "test/plugins-usage-readers.test.ts"],
  };
  for (const [path, tests] of Object.entries(mappings)) {
    expect(select([path])).toMatchObject({ full: false, bun: true, rust: true, e2e: true, codeql: true, focused_tests: tests });
    expect(select([path, "src/usage/plugin-readers.ts"])).toMatchObject({ full: true });
  }
  expect(select(Object.keys(mappings)).focused_tests).toEqual(Object.values(mappings).flat().sort());
});

test("uncovered CI implementations and workflows select full validation", () => {
  for (const path of ["scripts/ci/service-survival.ts", ".github/workflows/codeql.yml",
    ".github/workflows/pr-title.yml", ".github/workflows/scorecard.yml", ".github/workflows/desktop.yml",
    "AGENTS.md", "new-area/unknown.md"]) {
    expect(select([path])).toMatchObject({ bun: true, rust: true, e2e: true, ui: true, codeql: true, full: true });
    expect(select([".github/workflows/ci.yml", path])).toMatchObject({ full: true, rust: true, e2e: true });
  }
});

test("mixed changes use the union; protocol docs and fixtures retain freshness coverage", () => {
  expect(select(["docs/protocol.md", "test/fixtures/ui/tasks.json"]))
    .toMatchObject({ bun: true, e2e: true });
  expect(select(["app/README.md", "desktop/README.md"])).toMatchObject({ bun: false, rust: false, ui: false });
});


test("gate rejects missing classification and missing/failed required evidence", () => {
  const jobs = (Bun.YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as any).jobs;
  const gate = jobs.test.steps.at(-1).run;
  const run = (changes: string, required: string, evidence: string, release = "success") =>
    Bun.spawnSync(["bash", "-e", "-c", gate], { env: {
      ...process.env, CHANGES_RESULT: changes, UI_REQUIRED: required,
      UI_EVIDENCE_RESULT: evidence, RELEASE_READINESS_RESULT: release,
    } }).exitCode;
  expect(run("success", "false", "skipped")).toBe(0);
  expect(run("success", "true", "success")).toBe(0);
  for (const changes of ["failure", "cancelled", "skipped"]) expect(run(changes, "false", "skipped")).not.toBe(0);
  for (const evidence of ["failure", "cancelled", "skipped"]) expect(run("success", "true", evidence)).not.toBe(0);
  expect(run("success", "false", "skipped", "failure")).not.toBe(0);
  expect(jobs.test.env.RUN_CHECKS).toContain("needs.changes.outputs.bun == 'true'");
  for (const step of jobs.test.steps.slice(0, -1)) expect(step.if).toContain("env.RUN_CHECKS == 'true'");
  expect(jobs.rust.if).toContain("outputs.rust");
  expect(jobs.e2e.if).toContain("outputs.e2e");
  expect(jobs["ui-evidence"].if).toContain("outputs.ui");
});

test("the full suite always gets the locked test browser", () => {
  const steps = (Bun.YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as any).jobs.test.steps;
  const browser = steps.find((step: any) => step.name === "Install locked Chromium test browser");
  const suite = steps.find((step: any) => step.name === "Test (full suite, sharded)");
  // A test-only change runs the full suite without selecting e2e; its browser tests still need Chromium.
  expect(suite.if).toContain("outputs.full == 'true'");
  expect(browser.if).toContain("outputs.full == 'true'");
});

test("real git ranges cover renames, deletions, metadata refresh and missing-history fallback", () => {
  const directory = mkdtempSync(join(tmpdir(), "pacer-ci-"));
  const script = resolve("scripts/ci/changes.py");
  const command = (...args: string[]) => {
    const result = Bun.spawnSync(args, { cwd: directory });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    command("git", "init", "-q");
    command("git", "config", "user.name", "Fixture");
    command("git", "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(directory, "README.md"), "documentation");
    command("git", "add", "."); command("git", "commit", "-qm", "base");
    const base = command("git", "rev-parse", "HEAD");
    command("git", "mv", "README.md", "runtime.xyz");
    command("git", "commit", "-qam", "move");
    const head = command("git", "rev-parse", "HEAD");
    const invoke = (name: string, event: object) => {
      const output = join(directory, "output"); writeFileSync(output, "");
      const eventPath = join(directory, "event.json"); writeFileSync(eventPath, JSON.stringify(event));
      const run = Bun.spawnSync(["python3", script], { cwd: directory, env: {
        ...process.env, GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(directory, "summary"),
      } });
      expect(run.exitCode).toBe(0);
      return Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map(line => line.split("=")));
    };
    expect(invoke("push", { before: base, after: head })).toMatchObject({ bun: "true", rust: "true", timings: "true" });
    const pr = { action: "edited", pull_request: { base: { sha: base }, head: { sha: head } } };
    // A body edit must not replace failed checks for this SHA with untested success.
    expect(invoke("pull_request", pr)).toMatchObject({ bun: "true", ui: "true", timings: "false" });
    // A workflow-only diff gets the focused release and CI suite.
    command("git", "checkout", "-qb", "workflow", base);
    command("mkdir", "-p", ".github/workflows");
    writeFileSync(join(directory, ".github/workflows/ci.yml"), "name: CI\n");
    command("git", "add", ".github/workflows/ci.yml"); command("git", "commit", "-qm", "workflow");
    const workflowHead = command("git", "rev-parse", "HEAD");
    const focused = invoke("push", { before: base, after: workflowHead });
    expect(focused).toMatchObject({ bun: "true", rust: "false", full: "false" });
    expect(JSON.parse(focused.focused_tests)).toContain("test/release-workflow.test.ts");
    command("git", "checkout", "-qb", "source", base);
    command("mkdir", "-p", "src/classify");
    writeFileSync(join(directory, "src/classify/metrics.ts"), "original");
    command("git", "add", "src/classify/metrics.ts"); command("git", "commit", "-qm", "source base");
    const sourceBase = command("git", "rev-parse", "HEAD");
    writeFileSync(join(directory, "src/classify/metrics.ts"), "modified");
    command("git", "commit", "-qam", "modify source");
    const sourceHead = command("git", "rev-parse", "HEAD");
    const sourcePr = (head: string) => invoke("pull_request", { pull_request: { base: { sha: sourceBase }, head: { sha: head } } });
    expect(sourcePr(sourceHead)).toMatchObject({ full: "false", rust: "true", e2e: "true" });
    expect(invoke("push", { before: sourceBase, after: sourceHead })).toMatchObject({ full: "true" });
    command("git", "mv", "src/classify/metrics.ts", "src/classify/renamed.ts");
    command("git", "commit", "-qam", "rename source");
    expect(sourcePr(command("git", "rev-parse", "HEAD"))).toMatchObject({ full: "true" });
    command("git", "checkout", "-q", "--detach", sourceHead);
    command("git", "rm", "src/classify/metrics.ts"); command("git", "commit", "-qm", "delete source");
    expect(sourcePr(command("git", "rev-parse", "HEAD"))).toMatchObject({ full: "true" });
    command("git", "checkout", "-q", "--detach", sourceBase);
    command("git", "rm", "src/classify/metrics.ts"); command("git", "commit", "-qm", "remove before addition");
    const absentBase = command("git", "rev-parse", "HEAD");
    command("mkdir", "-p", "src/classify");
    writeFileSync(join(directory, "src/classify/metrics.ts"), "added");
    command("git", "add", "src/classify/metrics.ts"); command("git", "commit", "-qm", "add mapped source");
    expect(invoke("pull_request", { pull_request: { base: { sha: absentBase }, head: { sha: command("git", "rev-parse", "HEAD") } } })).toMatchObject({ full: "true" });
    command("git", "checkout", "-q", head);
    command("git", "rm", "runtime.xyz"); command("git", "commit", "-qm", "delete");
    expect(invoke("push", { before: head, after: command("git", "rev-parse", "HEAD") })).toMatchObject({ rust: "true" });
    expect(invoke("push", { before: "0".repeat(40), after: head })).toMatchObject({ bun: "true", rust: "true", ui: "true" });
    expect(invoke("pull_request", { pull_request: { base: { sha: "a".repeat(40) }, head: { sha: head } } })).toMatchObject({ e2e: "true" });
    expect(invoke("schedule", {})).toMatchObject({ codeql: "true", full: "true" });
    expect(invoke("workflow_dispatch", {})).toMatchObject({ codeql: "true", full: "true" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("every currently UI-scoped path also selects UI evidence", () => {
  for (const path of ["app/src/view.tsx", "app/build.ts", "src/app/assets.generated.ts",
    "src/dashboard/frame.ts", "src/render/table.ts", "src/view-model/words.ts",
    "desktop/ui/index.html", "desktop/src-tauri/src/main.rs", "desktop/src-tauri/icons/tray.png",
    "desktop/src-tauri/tauri.conf.json"]) expect(select([path]).ui).toBe(true);
});


test("workflow selection retains full-history detection and full scheduled CodeQL", () => {
  for (const name of ["ci", "codeql"]) {
    const workflow = Bun.YAML.parse(readFileSync(`.github/workflows/${name}.yml`, "utf8")) as any;
    expect(workflow.on.pull_request?.paths).toBeUndefined();
    const steps = workflow.jobs.changes.steps;
    expect(steps[0].with["fetch-depth"]).toBe(0);
    expect(steps[0].with["persist-credentials"]).toBe(false);
    expect(steps[1].run).toBe("python3 scripts/ci/changes.py");
  }
  const codeql = Bun.YAML.parse(readFileSync(".github/workflows/codeql.yml", "utf8")) as any;
  expect(codeql.on.schedule.length).toBeGreaterThan(0);
  expect(codeql.jobs.analyze.if).toContain("needs.changes.result != 'success'");
  const ci = Bun.YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as any;
  expect(ci.jobs.test["runs-on"]).toContain("|| 'ubuntu-latest'");
  // PRs run only Linux logic tests; required Test names stay, macOS work moves to main/schedule/dispatch.
  const prLinuxOnly = "github.event_name != 'pull_request' || matrix.os == 'ubuntu-latest'";
  expect(ci.jobs.test.strategy.matrix.os).toEqual(["ubuntu-latest", "macos-latest"]);
  expect(ci.jobs.test["runs-on"]).toContain(prLinuxOnly);
  expect(ci.jobs.test.env.RUN_CHECKS).toContain(prLinuxOnly);
  expect(ci.jobs.rust.strategy.matrix.os).toContain("github.event_name == 'pull_request' && '[\"ubuntu-latest\"]'");
  expect(ci.jobs.rust.strategy.matrix.os).toContain("macos-latest");
  for (const job of ["e2e", "linux-service-survival"]) expect(ci.jobs[job].if).toContain("github.event_name != 'pull_request'");
  for (const step of ci.jobs.rust.steps.filter((step: any) => /timings/i.test(step.name))) {
    expect(step.if).toContain("outputs.timings == 'true'");
  }
});
