import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../scripts/ui-ready.ts", import.meta.url).pathname;

test("preflight checks real git history, draft status and current evidence without rewriting inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "pacer-ui-ready-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${root}/no-hooks`, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const event = join(root, "event.json");
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, script, ...args], { cwd: root, env: process.env, stdout: "pipe", stderr: "pipe" });
  try {
    git("init", "--quiet");
    mkdirSync(join(root, "app/src"), { recursive: true });
    writeFileSync(join(root, "app/src/main.tsx"), "export const title = 'base';\n");
    git("add", "--all"); git("commit", "-m", "test: base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(root, "app/src/main.tsx"), "export const title = 'changed';\n");
    git("add", "--all"); git("commit", "-m", "test: UI change");
    const head = git("rev-parse", "HEAD");
    const report = { verdict: "PASS", report: "https://example.invalid/reports/1", summary: "Checked applicable rules and recorded passing evidence." };
    const manifest = { version: 1, base, head, compliance: { ...report }, ui: { ...report }, qa: { ...report } };
    const write = (value: unknown = manifest, draft = false) => writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head }, draft, body: `<!-- pacer-ui-evidence\n${JSON.stringify(value)}\n-->` } }));
    write();
    const before = readFileSync(event, "utf8");
    const pass = run("--event", event);
    expect(pass.exitCode).toBe(0);
    expect(pass.stdout.toString()).toContain("UI review readiness metadata: PASS");
    expect(readFileSync(event, "utf8")).toBe(before);
    for (const key of ["base", "head"] as const) {
      write({ ...manifest, [key]: "c".repeat(40) });
      const stale = run("--event", event);
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr.toString()).toContain(`Evidence ${key}`);
    }
    write({ ...manifest, ui: { ...report, verdict: "UNVERIFIED", summary: "Native evidence remains UNVERIFIED." } }, true);
    const draft = run("--event", event);
    expect(draft.exitCode).toBe(0);
    expect(draft.stdout.toString()).toContain("Draft evidence metadata: PASS");
    expect(draft.stdout.toString()).toContain("not review readiness");
    const ready = run("--event", event, "--ready");
    expect(ready.exitCode).toBe(1);
    expect(ready.stderr.toString()).toContain("ui verdict must be PASS");
    write({ ...manifest, qa: { ...report, report: ".work/reviews/qa.md" } });
    expect(run("--event", event).exitCode).toBe(1);
    writeFileSync(event, JSON.stringify({ pull_request: { draft: false, base: { sha: base }, head: { sha: head }, body: "" } }));
    expect(run("--event", event).stderr.toString()).toContain("exactly one pacer-ui-evidence");
    writeFileSync(event, JSON.stringify({ pull_request: { draft: false, base: { sha: base }, head: { sha: "d".repeat(40) }, body: "" } }));
    expect(run("--event", event).stderr.toString()).toContain("Cannot inspect changed UI files");

    // gh is replaced only at the external API boundary; validation still uses real git.
    write();
    const bin = join(root, "bin"), raw = join(root, "pr.json"), argsFile = join(root, "gh-args");
    mkdirSync(bin);
    writeFileSync(raw, JSON.stringify(JSON.parse(readFileSync(event, "utf8")).pull_request));
    writeFileSync(join(bin, "gh"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$UI_READY_ARGS"\ncat "$UI_READY_PR"\n');
    chmodSync(join(bin, "gh"), 0o755);
    const pr = Bun.spawnSync([process.execPath, script, "--pr", "304", "--ready"], {
      cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UI_READY_PR: raw, UI_READY_ARGS: argsFile }, stdout: "pipe", stderr: "pipe",
    });
    expect(pr.exitCode).toBe(0);
    expect(readFileSync(argsFile, "utf8")).toBe("api\nrepos/{owner}/{repo}/pulls/304\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preflight fails closed for missing, malformed and non-PR inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "pacer-ui-ready-input-"));
  const event = join(root, "event.json");
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, script, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  try {
    for (const args of [[], ["--pr", "--help"], ["--pr", "1;echo unsafe"], ["--pr", "0"], ["--event", event, "--pr", "1"], ["--event", event, "--typo"], ["--event"], ["--ready"]]) {
      expect(run(...args).exitCode).toBe(1);
    }
    expect(run("--event", event).exitCode).toBe(1);
    for (const value of ["not JSON", "{}", "null", '{"pull_request":{}}', '{"pull_request":{"base":{"sha":"bad"},"head":{"sha":"bad"},"body":""}}']) {
      writeFileSync(event, value);
      expect(run("--event", event).exitCode).toBe(1);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
