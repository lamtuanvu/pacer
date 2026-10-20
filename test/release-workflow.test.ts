import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpDir } from "./helpers";

const workflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
interface WorkflowStep {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface WorkflowJob {
  needs?: string | string[];
  strategy?: { matrix: { include: Record<string, string>[] } };
  steps: WorkflowStep[];
}
const jobs = (Bun.YAML.parse(workflow) as { jobs: Record<string, WorkflowJob> }).jobs;
function step(name: string): string {
  const lines = workflow.split(`      - name: ${name}\n`)[1].split("        run: |\n")[1].split("\n");
  const end = lines.findIndex(line => line.trim() !== "" && !line.startsWith("          "));
  return lines.slice(0, end === -1 ? undefined : end).map(line => line.replace(/^          /, "")).join("\n");
}

function run(script: string, cwd: string, env: Record<string, string>) {
  return Bun.spawnSync(["bash", "-euo", "pipefail", "-c", script], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
}

test("desktop release builds every OS and architecture from the matching CLI artifact", () => {
  const desktop = jobs.desktop;
  expect(desktop).toBeDefined();
  expect(desktop.needs).toEqual(["verify", "build"]);
  expect(desktop.strategy?.matrix.include).toEqual([
    { runner: "macos-latest", target: "aarch64-apple-darwin", platform: "darwin-arm64", cli_artifact: "binaries-macos-latest", bundles: "dmg" },
    { runner: "macos-latest", target: "x86_64-apple-darwin", platform: "darwin-x64", cli_artifact: "binaries-macos-latest", bundles: "dmg" },
    { runner: "ubuntu-24.04", target: "x86_64-unknown-linux-gnu", platform: "linux-x64", cli_artifact: "binaries-ubuntu-latest", bundles: "appimage,deb" },
    { runner: "ubuntu-24.04-arm", target: "aarch64-unknown-linux-gnu", platform: "linux-arm64", cli_artifact: "binaries-ubuntu-latest", bundles: "appimage,deb" },
  ]);
  const download = desktop.steps.find(s => s.uses?.startsWith("actions/download-artifact@"));
  expect(download?.with).toMatchObject({ name: "${{ matrix.cli_artifact }}", path: "dist/release" });
  const stage = desktop.steps.find(s => s.name === "Stage release CLI");
  expect(stage?.env?.TAURI_TARGET_TRIPLE).toBe("${{ matrix.target }}");
  expect(stage?.run).toContain('desktop/scripts/stage-cli.sh "$cli"');
  const build = desktop.steps.find(s => s.name === "Build unsigned desktop bundles");
  expect(build?.env?.CARGO_NET_OFFLINE).toBe("true");
  expect(build?.run).toContain('--target "$TARGET" --bundles "$BUNDLES" --no-sign');
  // Linux AppImages are repacked around the real CLI so linuxdeploy never rewrites it (#217).
  expect(build?.run).toContain('./scripts/build-linux-bundles.sh "../dist/release/$VERSION/pacer-$PLATFORM" "$VERSION" "$TARGET"');
  const upload = desktop.steps.find(s => s.uses?.startsWith("actions/upload-artifact@"));
  expect(upload?.with).toMatchObject({ name: "desktop-${{ matrix.platform }}-unsigned", path: "dist/desktop/pacer-*", "if-no-files-found": "error" });
});

test("desktop bundle collection gives all downloads versioned unsigned names", () => {
  expect(jobs.desktop).toBeDefined();
  for (const [target, platform, bundles] of [
    ["aarch64-apple-darwin", "darwin-arm64", ["dmg"]],
    ["x86_64-apple-darwin", "darwin-x64", ["dmg"]],
    ["x86_64-unknown-linux-gnu", "linux-x64", ["appimage", "deb"]],
    ["aarch64-unknown-linux-gnu", "linux-arm64", ["appimage", "deb"]],
  ] as const) {
    const root = tmpDir();
    const files = bundles.map(bundle => {
      const ext = bundle === "appimage" ? "AppImage" : bundle;
      const dir = join(root, "desktop/src-tauri/target", target, "release/bundle", bundle);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `pacer_1.2.3.${ext}`), `${platform}-${ext}`);
      return `pacer-1.2.3-${platform}-unsigned.${ext}`;
    });
    const result = run(step("Collect unsigned desktop bundles"), root, { VERSION: "1.2.3", TARGET: target, PLATFORM: platform, BUNDLES: bundles.join(",") });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(readdirSync(join(root, "dist/desktop")).sort()).toEqual(files.sort());
    for (const file of files) {
      expect(readFileSync(join(root, "dist/desktop", file), "utf8")).toBe(`${platform}-${file.split(".").at(-1)}`);
    }
  }
});

test("publish includes desktop downloads in checksums, provenance and release assets, including dry runs", () => {
  const publish = jobs.publish;
  expect(publish.needs).toContain("desktop");
  const downloadIndex = publish.steps.findIndex(s => s.with?.pattern === "desktop-*");
  expect(downloadIndex).toBeGreaterThan(-1);
  const download = publish.steps[downloadIndex];
  expect(download.if).toBeUndefined();
  expect(download.with).toMatchObject({ path: "dist/release/${{ env.VERSION }}", "merge-multiple": true });
  const checksumIndex = publish.steps.findIndex(s => s.name === "Add desktop checksums");
  expect(checksumIndex).toBeGreaterThan(downloadIndex);
  expect(checksumIndex).toBeGreaterThan(publish.steps.findIndex(s => s.name === "Write checksums and metadata"));
  const root = tmpDir(), dir = join(root, "dist/release/1.2.3");
  mkdirSync(dir, { recursive: true });
  const cliSum = `${"a".repeat(64)}  pacer-darwin-arm64\n`;
  writeFileSync(join(dir, "SHA256SUMS"), cliSum);
  const files = ["pacer-1.2.3-darwin-arm64-unsigned.dmg", "pacer-1.2.3-darwin-x64-unsigned.dmg",
    "pacer-1.2.3-linux-x64-unsigned.AppImage", "pacer-1.2.3-linux-x64-unsigned.deb",
    "pacer-1.2.3-linux-arm64-unsigned.AppImage", "pacer-1.2.3-linux-arm64-unsigned.deb"];
  for (const file of files) writeFileSync(join(dir, file), file);
  expect(run(step("Add desktop checksums"), root, { VERSION: "1.2.3" }).exitCode).toBe(0);
  const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8");
  expect(sums.startsWith(cliSum)).toBe(true);
  for (const file of files) expect(sums).toContain(`${createHash("sha256").update(file).digest("hex")}  ${file}\n`);
  expect(publish.steps.find(s => s.uses?.startsWith("actions/attest-build-provenance@"))?.with?.["subject-path"])
    .toBe("dist/release/*/pacer-*");
  expect(step("Publish release")).toContain('dist/release/"$version"/pacer-*');
  writeFileSync(join(root, "CHANGELOG.md"), "## [1.2.3]\n\nRelease details.\n\n## [1.2.2]\nOld.\n");
  expect(run(step("Extract release notes"), root, { VERSION: "1.2.3" }).exitCode).toBe(0);
  expect(readFileSync(join(root, "release-notes.md"), "utf8"))
    .toContain("The app is not yet signed. On first open, Control-click pacer in Applications and choose Open.");
});

test("every release action is SHA-pinned and checkout does not persist credentials", () => {
  for (const job of Object.values(jobs)) {
    for (const action of job.steps.filter(s => s.uses)) {
      expect(action.uses).toMatch(/^[\w/-]+@[a-f0-9]{40}$/);
      if (action.uses?.startsWith("actions/checkout@")) expect(action.with?.["persist-credentials"]).toBe(false);
    }
  }
});

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
