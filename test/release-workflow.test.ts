import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpDir } from "./helpers";

const workflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
function step(name: string): string {
  const lines = workflow.split(`      - name: ${name}\n`)[1].split("        run: |\n")[1].split("\n");
  const end = lines.findIndex(line => line.trim() !== "" && !line.startsWith("          "));
  return lines.slice(0, end === -1 ? undefined : end).map(line => line.replace(/^          /, "")).join("\n");
}

function run(script: string, cwd: string, env: Record<string, string>) {
  return Bun.spawnSync(["bash", "-euo", "pipefail", "-c", script], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
}

test("release dispatch verifies the package version and refuses non-dry dispatches", () => {
  const root = tmpDir(); writeFileSync(join(root, "package.json"), '{"version":"1.2.3"}');
  const env = { GITHUB_EVENT_NAME: "workflow_dispatch", VERSION: "1.2.3", DRY_RUN: "true" };
  expect(run(step("Verify release request"), root, env).exitCode).toBe(0);
  expect(run(step("Verify release request"), root, { ...env, DRY_RUN: "false" }).exitCode).not.toBe(0);
  expect(run(step("Verify release request"), root, { ...env, VERSION: "1.2.4" }).exitCode).not.toBe(0);
  expect(run(step("Verify release request"), root, { ...env, GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "v1.2.3" }).exitCode).toBe(0);
});

test("npm publishing respects package order, skips exact published versions and dry-runs prereleases", () => {
  const root = tmpDir(), bin = join(root, "bin"), out = join(root, "dist/npm"), log = join(root, "npm.log");
  mkdirSync(bin); mkdirSync(out, { recursive: true });
  writeFileSync(join(bin, "npm"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$NPM_LOG"\nif test "$1" = view; then case "$2" in *@lamtuanvu/platform@*) exit 0 ;; *) exit 1 ;; esac; fi\n`);
  chmodSync(join(bin, "npm"), 0o755);
  for (const name of ["platform", "pacer"]) {
    mkdirSync(join(out, name)); writeFileSync(join(out, name, "package.json"), JSON.stringify({ name: `@lamtuanvu/${name}` }));
  }
  writeFileSync(join(out, "publish-order.txt"), "platform\npacer\n");
  const env = { PATH: `${bin}:${process.env.PATH}`, NPM_LOG: log, VERSION: "1.2.3", DRY_RUN: "false" };
  expect(run(step("Publish npm packages in dependency order"), root, env).exitCode).toBe(0);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "view @lamtuanvu/platform@1.2.3 version", "view @lamtuanvu/pacer@1.2.3 version", "publish --provenance --access public --tag latest",
  ]);
  writeFileSync(log, "");
  expect(run(step("Publish npm packages in dependency order"), root, { ...env, DRY_RUN: "true", VERSION: "1.2.3-beta.1" }).exitCode).toBe(0);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "view @lamtuanvu/platform@1.2.3-beta.1 version",
    "view @lamtuanvu/pacer@1.2.3-beta.1 version", "publish --dry-run --access public --tag next",
  ]);
});

test("Homebrew configuration reports missing credentials and permits credential-free dry runs", () => {
  const root = tmpDir(), output = join(root, "output");
  const env = { GITHUB_OUTPUT: output, HOMEBREW_TAP_TOKEN: "", DRY_RUN: "false" };
  const skipped = run(step("Check tap publishing configuration"), root, env);
  expect(skipped.exitCode).toBe(0);
  expect(skipped.stdout.toString()).toContain("skipped: HOMEBREW_TAP_TOKEN not set");
  expect(run(step("Check tap publishing configuration"), root, { ...env, DRY_RUN: "true" }).exitCode).toBe(0);
  expect(readFileSync(output, "utf8")).toBe("enabled=true\n");
});
