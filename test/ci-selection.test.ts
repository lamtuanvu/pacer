import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function select(paths: string[]) {
  const run = Bun.spawnSync(["python3", "scripts/ci/changes.py", "--paths-json", JSON.stringify(paths)]);
  expect(run.exitCode).toBe(0);
  return JSON.parse(run.stdout.toString()) as Record<string, boolean>;
}

test("docs and portable skills avoid compiler/browser jobs", () => {
  expect(select(["AGENTS.md", ".project/rules/ui.md", ".agents/skills/project-review/SKILL.md", "docs/accounts.md"]))
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
  for (const path of ["bun.lock", "package.json", ".github/workflows/ci.yml", "scripts/ci/changes.py", "new-runtime/file.xyz"]) {
    expect(select([path])).toMatchObject({ bun: true, rust: true, e2e: true, ui: true, codeql: true });
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
  for (const step of jobs.test.steps.slice(0, -1)) expect(step.if).toContain("needs.changes.outputs.bun == 'true'");
  expect(jobs.rust.if).toContain("outputs.rust");
  expect(jobs.e2e.if).toContain("outputs.e2e");
  expect(jobs["ui-evidence"].if).toContain("outputs.ui");
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
    command("git", "rm", "runtime.xyz"); command("git", "commit", "-qm", "delete");
    expect(invoke("push", { before: head, after: command("git", "rev-parse", "HEAD") })).toMatchObject({ rust: "true" });
    expect(invoke("push", { before: "0".repeat(40), after: head })).toMatchObject({ bun: "true", rust: "true", ui: "true" });
    expect(invoke("pull_request", { pull_request: { base: { sha: "a".repeat(40) }, head: { sha: head } } })).toMatchObject({ e2e: "true" });
    expect(invoke("schedule", {})).toMatchObject({ codeql: "true" });
    expect(invoke("workflow_dispatch", {})).toMatchObject({ codeql: "true" });
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
  for (const step of ci.jobs.rust.steps.filter((step: any) => /timings/i.test(step.name))) {
    expect(step.if).toContain("outputs.timings == 'true'");
  }
});
