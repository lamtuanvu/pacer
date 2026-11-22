import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
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
  if?: string;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
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
  expect(desktop.needs).toEqual(["verify", "build-linux"]);
  expect(desktop.strategy?.matrix.include).toEqual([
    // macOS ships only the signed, auto-updating app from desktop-build.
    { runner: "ubuntu-24.04", target: "x86_64-unknown-linux-gnu", platform: "linux-x64", cli_artifact: "binaries-linux-x64", bundles: "appimage,deb" },
    { runner: "ubuntu-24.04-arm", target: "aarch64-unknown-linux-gnu", platform: "linux-arm64", cli_artifact: "binaries-linux-arm64", bundles: "appimage,deb" },
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
  const downloadIndex = publish.steps.findIndex(s => s.with?.pattern === "desktop-linux-*-unsigned");
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
  const files = ["pacer-1.2.3-linux-x64-unsigned.AppImage", "pacer-1.2.3-linux-x64-unsigned.deb",
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
  writeFileSync(log, "");
  expect(run(step("Publish npm packages in dependency order"), root, { ...env, VERSION: "0.16.0-nightly.202611171700" }).exitCode).toBe(0);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "view @lamtuanvu/platform@0.16.0-nightly.202611171700 version",
    "view @lamtuanvu/pacer@0.16.0-nightly.202611171700 version", "publish --provenance --access public --tag nightly",
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

test("the release builds and publishes; validation runs post-merge on main", () => {
  expect(jobs.build).toBeUndefined();
  const macos = jobs["build-macos"];
  const linux = jobs["build-linux"];
  for (const build of [macos, linux]) {
    expect(build.needs).toBe("verify");
    expect((build as any).if).toBeUndefined();
    expect((build as any).strategy["fail-fast"]).toBe(false);
    expect((build as any)["continue-on-error"]).toBeUndefined();
    expect(build.steps.find(s => s.name === "M1 gate checks against built host release artifacts")).toBeUndefined();
    expect(build.steps.find(s => s.name === "Smoke test native binary")).toBeDefined();
    // CLI legs are off the critical path; only desktop caches are warmed (10GB cache budget).
    expect(build.steps.find(s => s.uses?.startsWith("Swatinem/rust-cache@"))).toBeUndefined();
    const upload = build.steps.find(s => s.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.with).toMatchObject({ name: "binaries-${{ matrix.os }}-${{ matrix.arch }}", path: "dist/release/*/pacer-*" });
    const smoke = build.steps.find(s => s.name === "Smoke test native binary")?.run ?? "";
    expect(smoke).toContain('os="${{ matrix.os }}"');
    expect(smoke).toContain('arch="${{ matrix.arch }}"');
    expect(smoke).not.toContain("uname");
  }
  expect(macos.strategy?.matrix.include).toEqual([
    { os: "darwin", arch: "arm64", target: "darwin-arm64", image: "macos-15", rust_target: "aarch64-apple-darwin" },
    { os: "darwin", arch: "x64", target: "darwin-x64", image: "macos-15", rust_target: "x86_64-apple-darwin", smoke_prefix: "arch -x86_64" },
  ]);
  expect(linux.strategy?.matrix.include).toEqual([
    { os: "linux", arch: "x64", target: "linux-x64", image: "ubuntu-24.04", rust_target: "x86_64-unknown-linux-musl" },
    { os: "linux", arch: "arm64", target: "linux-arm64", image: "ubuntu-24.04-arm", rust_target: "aarch64-unknown-linux-musl" },
  ]);
  expect(macos.steps.find(s => s.name === "Install Linux cross-build tools")).toBeUndefined();
  expect(linux.steps.find(s => s.name === "Install Linux cross-build tools")?.run).toContain("cargo-zigbuild");
  expect(macos.steps.find(s => s.name === "Smoke test native binary")?.run).toContain("${{ matrix.smoke_prefix }}");
  // Amendment 0.24.0 (proposed): the release only builds and publishes; no M1 gate, no CI-suite gate.
  expect(jobs["ci-suite"]).toBeUndefined();
  expect(workflow).not.toContain("gate:m1");
  expect(workflow).not.toContain("ci-evidence");
  expect(jobs.publish.needs).toEqual(["verify", "build-macos", "build-linux", "desktop"]);
  for (const name of ["npm", "homebrew", "crates", "desktop-publish"]) {
    expect(jobs[name].needs).toContain("publish");
    if (name === "npm" || name === "homebrew") expect((jobs[name] as any).if).toContain("needs.publish.result == 'success'");
    else expect((jobs[name] as any).if ?? "").not.toContain("always()");
  }
  for (const job of ["publish", "npm", "homebrew"]) {
    const download = jobs[job].steps.find(s => s.with?.pattern === "binaries-*");
    expect(download?.with).toMatchObject({ "merge-multiple": true, path: "dist/release" });
  }
  const verify = jobs.verify.steps.map(s => s.run ?? "").join("\n");
  expect(verify).toContain("bun run typecheck");
  // CI's Rust job already runs `cargo test -p pacer-plugin --features testing`; verify no longer repeats it.
  expect(verify).not.toContain("cargo test");
  expect(verify).not.toContain("bun run test");
  expect(jobs.verify.steps.some(s => s.uses?.startsWith("dtolnay/rust-toolchain@"))).toBe(false);
  const source = readFileSync("scripts/gate/m1.ts", "utf8");
  expect(source).toContain('validateM1Artifacts(dir)');
  expect(source).toContain('[process.execPath, "run", "test", ...files]');
  expect(source).toContain('PACER_TEST_FRONT_DOOR: front');
  expect(source).toContain('PACER_TEST_REFERENCE_CORE: core');
  expect(source).toContain('return failures ? 1 : 0');
});

test("the M1 gate runs post-merge on main in CI instead of the release", () => {
  const ci = Bun.YAML.parse(readFileSync(resolve(".github/workflows/ci.yml"), "utf8")) as {
    on: Record<string, unknown>;
    jobs: Record<string, WorkflowJob & { "timeout-minutes"?: number; name?: string }>;
  };
  // ci.yml's push trigger is already main-only; the gate never runs on PRs, tags or dispatches.
  expect(ci.on.push).toEqual({ branches: ["main"] });
  const gate = ci.jobs["m1-gate"]!;
  expect(gate.name).toBe("M1 gate against built release artifacts (post-merge)");
  expect(gate.if).toBe("${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}");
  expect(gate["timeout-minutes"]).toBeLessThanOrEqual(45);
  expect(gate.strategy?.matrix.include).toEqual([
    { runner: "macos-latest", targets: "darwin-arm64,darwin-x64" },
    { runner: "ubuntu-24.04", targets: "linux-x64,linux-arm64" },
  ]);
  // Shared release-build recipe steps (matrix and cache stay paired; release.yml uses per-target jobs).
  const names = gate.steps.map(s => s.name ?? s.uses ?? s.run);
  for (const step of ["Install dependencies", "Install Rust release targets", "Install Linux cross-build tools", "Build runner targets", "Build the Rust fixture plugin", "M1 gate checks against built host release artifacts"]) {
    expect(names).toContain(step);
  }
  const cache = gate.steps.find(s => s.uses?.startsWith("Swatinem/rust-cache@"));
  expect(cache?.with).toMatchObject({
    "shared-key": "release-pair-${{ matrix.runner }}",
    "save-if": "${{ github.ref == 'refs/heads/main' }}",
  });
  // Every install/download step is bounded at 10 minutes.
  const installs = gate.steps.filter(s => s.run && /bun install|rustup target add|pip" install|cargo build --locked -p pacer-fixtures/.test(s.run));
  expect(installs).toHaveLength(4);
  for (const install of installs) {
    expect((install as any)["timeout-minutes"]).toBeLessThanOrEqual(10);
  }
  const run = gate.steps.find(s => s.name === "M1 gate checks against built host release artifacts")!;
  expect(run.run).toContain('bun run gate:m1 --release-dir "dist/release/$VERSION" --bun-suite skip');
  const upload = gate.steps.find(s => s.uses?.startsWith("actions/upload-artifact@"));
  expect(upload?.if).toBe("always()");
  expect(upload?.with).toMatchObject({ name: "m1-gate-post-merge-${{ matrix.runner }}", path: "${{ runner.temp }}/pacer-m1-gate.log" });
});

test("a failed M1 gate fails the post-merge job despite log capture", () => {
  const root = tmpDir(), bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bun"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  const ci = Bun.YAML.parse(readFileSync(resolve(".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, WorkflowJob> };
  const gateStep = ci.jobs["m1-gate"].steps.find(s => s.name === "M1 gate checks against built host release artifacts")!;
  const result = run(gateStep.run!, root, { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root });
  expect(result.exitCode).not.toBe(0);
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

/** A repository whose main (also pushed to a bare origin) holds the stable `v0.15.1` tag and `feat: one`, with the real release scripts linked in. */
function nightlyRepo(): string {
  const root = tmpDir();
  symlinkSync(resolve("scripts"), join(root, "scripts"));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "package.json"), '{"version":"0.15.1"}\n');
  git(root, "add", "-A"); git(root, "commit", "-qm", "chore: initial"); git(root, "tag", "-a", "v0.15.1", "-m", "pacer 0.15.1");
  writeFileSync(join(root, "README.md"), "one\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "feat: one");
  // A bare origin whose main matches, so verify can check that a nightly's parent is on origin/main.
  const origin = join(tmpDir(), "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "origin", "main");
  return root;
}

/** A stamp commit on top of the current HEAD, tagged like nightly.yml tags it; `extra` sneaks in another file. */
function stamp(root: string, version: string, extra = false): string {
  git(root, "switch", "-q", "--detach");
  writeFileSync(join(root, "package.json"), `{"version":"${version}"}\n`);
  if (extra) writeFileSync(join(root, "README.md"), "sneaked\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", `chore: nightly ${version}`);
  git(root, "tag", "-a", `v${version}`, "-m", `pacer ${version}`);
  return git(root, "rev-parse", "HEAD");
}

const outputs = (file: string) => Object.fromEntries(readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => line.split("=", 2) as [string, string]));

test("verify classifies the channel and checks that a nightly stamp only changes version files", { timeout: 20_000 }, () => {
  const verify = jobs.verify;
  expect(verify.outputs).toMatchObject({ channel: "${{ steps.channel.outputs.channel }}", parent: "${{ steps.channel.outputs.parent }}" });
  // check-diff reads the stamp commit's parent.
  expect(verify.steps.find(s => s.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"]).toBe(2);
  const names = verify.steps.map(s => s.name ?? s.run);
  expect(names.indexOf("Classify the release channel")).toBeGreaterThan(names.indexOf("bun install --frozen-lockfile"));

  const stable = nightlyRepo(), stableOut = join(stable, "out");
  const stableRun = run(step("Classify the release channel"), stable, { GITHUB_OUTPUT: stableOut });
  expect(stableRun.exitCode).toBe(0);
  expect(outputs(stableOut)).toEqual({ channel: "stable" });

  const rc = nightlyRepo(), rcOut = join(rc, "out");
  writeFileSync(join(rc, "package.json"), '{"version":"0.16.0-rc.1"}\n');
  expect(run(step("Classify the release channel"), rc, { GITHUB_OUTPUT: rcOut }).exitCode).toBe(0);
  expect(outputs(rcOut)).toEqual({ channel: "prerelease" });

  const nightly = nightlyRepo(), nightlyOut = join(nightly, "out");
  const parent = git(nightly, "rev-parse", "HEAD");
  stamp(nightly, "0.16.0-nightly.202611171700");
  const clean = run(step("Classify the release channel"), nightly, { GITHUB_OUTPUT: nightlyOut });
  expect(clean.stderr.toString()).toBe("");
  expect(clean.exitCode).toBe(0);
  expect(outputs(nightlyOut)).toEqual({ channel: "nightly", parent });

  const sneaky = nightlyRepo();
  stamp(sneaky, "0.16.0-nightly.202611171700", true);
  const refused = run(step("Classify the release channel"), sneaky, { GITHUB_OUTPUT: join(sneaky, "out") });
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stderr.toString()).toContain("README.md");

  // A stamp on a commit that is not on origin/main is refused, even if it changes only version files.
  const side = nightlyRepo();
  git(side, "switch", "-q", "-c", "side");
  writeFileSync(join(side, "side.txt"), "side\n");
  git(side, "add", "-A"); git(side, "commit", "-qm", "feat: side");
  const sideParent = git(side, "rev-parse", "HEAD");
  stamp(side, "0.16.0-nightly.202611171700");
  const offMain = run(step("Classify the release channel"), side, { GITHUB_OUTPUT: join(side, "out") });
  expect(offMain.exitCode).not.toBe(0);
  expect(offMain.stdout.toString()).toContain(`::error::The nightly's parent ${sideParent} is not on main`);
});

test("nightly release notes list main's commits since the previous nightly; stable keeps the CHANGELOG", () => {
  const root = nightlyRepo();
  const first = "0.16.0-nightly.202611171700", second = "0.16.0-nightly.202611181700";
  stamp(root, first);
  git(root, "switch", "-q", "main");
  writeFileSync(join(root, "README.md"), "two\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "fix: two");
  stamp(root, second);
  expect(jobs.publish.env?.CHANNEL).toBe("${{ needs.verify.outputs.channel }}");
  expect(run(step("Extract release notes"), root, { VERSION: second, CHANNEL: "nightly" }).exitCode).toBe(0);
  const notes = readFileSync(join(root, "release-notes.md"), "utf8");
  expect(notes).toContain(`## pacer ${second}`);
  expect(notes).toContain("- fix: two");
  expect(notes).not.toContain("feat: one");
  expect(notes).not.toContain("chore: nightly");
  expect(notes).toContain("The app is not yet signed.");

  // The first nightly after a stable release starts from that stable tag.
  git(root, "switch", "-q", "--detach", `v${first}`);
  expect(run(step("Extract release notes"), root, { VERSION: first, CHANNEL: "nightly" }).exitCode).toBe(0);
  const firstNotes = readFileSync(join(root, "release-notes.md"), "utf8");
  expect(firstNotes).toContain("- feat: one");
  expect(firstNotes).not.toContain("chore: initial");
  expect(firstNotes).not.toContain("fix: two");

  // A nightly never needs a CHANGELOG section; a stable release still does.
  expect(run(step("Extract release notes"), root, { VERSION: "0.15.1", CHANNEL: "stable" }).exitCode).not.toBe(0);
});

test("the nightly desktop manifest uses the generated notes", () => {
  const publish = jobs["desktop-publish"];
  expect(publish.env?.CHANNEL).toBe("${{ needs.verify.outputs.channel }}");
  const root = nightlyRepo(), bin = join(root, "bin"), log = join(root, "bun.log");
  const version = "0.16.0-nightly.202611171700";
  stamp(root, version);
  mkdirSync(bin);
  // Record the desktop-release call; run everything else with the real bun.
  writeFileSync(join(bin, "bun"), `#!/bin/sh\nif test "$1" = scripts/release/desktop-release.ts; then printf '%s\\n' "$*" >> "$BUN_LOG"; exit 0; fi\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, BUN_LOG: log, VERSION: version, CHANNEL: "nightly" };
  expect(run(step("Prepare deterministic desktop metadata"), root, env).exitCode).toBe(0);
  expect(readFileSync(log, "utf8")).toBe(`scripts/release/desktop-release.ts prepare dist/desktop-assets ${version} --notes-file release-notes.md\n`);
  expect(readFileSync(join(root, "release-notes.md"), "utf8")).toContain("- feat: one");
  writeFileSync(log, "");
  expect(run(step("Prepare deterministic desktop metadata"), root, { ...env, VERSION: "0.15.1", CHANNEL: "stable" }).exitCode).toBe(0);
  expect(readFileSync(log, "utf8")).toBe("scripts/release/desktop-release.ts prepare dist/desktop-assets 0.15.1\n");
});

test("nightlies skip crates.io and advance the CLI feed only after the desktop feed", () => {
  expect(jobs.crates.if).toContain("github.event_name == 'push'");
  expect(jobs.crates.if).toContain("!contains(needs.verify.outputs.version, '-')");
  const feed = jobs["cli-feed"];
  expect(feed).toBeDefined();
  expect(feed.needs).toEqual(["verify", "publish", "desktop-publish"]);
  expect(feed.if).toBe("github.event_name == 'push' && needs.verify.outputs.channel == 'nightly' && needs.desktop-publish.result == 'success'");
  expect(feed.permissions).toEqual({ contents: "write", issues: "write" });
  const publish = feed.steps.find(s => s.name === "Compare-and-swap the CLI nightly feed")!;
  expect(publish.run).toBe('bun scripts/release/cli-feed.ts publish "$VERSION"');
  expect(publish.env?.GH_TOKEN).toBe("${{ github.token }}");
  const names = feed.steps.map(s => s.name);
  expect(names.indexOf("Close nightly failure issues")).toBeGreaterThan(names.indexOf("Compare-and-swap the CLI nightly feed"));
});

test("a published nightly closes every open nightly-failure issue", () => {
  const root = tmpDir(), bin = join(root, "bin"), log = join(root, "gh.log");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GH_LOG"\nif test "$1 $2" = "issue list"; then printf \'7\\n9\\n\'; fi\n', { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, GH_LOG: log, VERSION: "0.16.0-nightly.202611171700", GITHUB_REPOSITORY: "fixture/repo", GITHUB_SERVER_URL: "https://github.example", GITHUB_RUN_ID: "42" };
  expect(run(step("Close nightly failure issues"), root, env).exitCode).toBe(0);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  expect(calls[0]).toContain("issue list --repo fixture/repo --label nightly-failure --state open");
  expect(calls.slice(1)).toEqual([7, 9].map(n => `issue close ${n} --repo fixture/repo --comment Nightly 0.16.0-nightly.202611171700 published: https://github.example/fixture/repo/actions/runs/42`));
});

test("release Rust caches restore shared keys warmed on main; PR CI does not save Rust caches", () => {
  const warmerRaw = readFileSync(resolve(".github/workflows/release-cache.yml"), "utf8");
  expect(warmerRaw).not.toMatch(/secrets\./);
  const warmer = Bun.YAML.parse(warmerRaw) as {
    on: { push?: { branches?: string[]; paths?: string[] }; schedule?: unknown[]; workflow_dispatch?: unknown };
    permissions: Record<string, string>;
    jobs: Record<string, WorkflowJob & { "runs-on"?: string }>;
  };
  expect(warmer.permissions).toEqual({ contents: "read" });
  expect(warmer.on.push?.branches).toEqual(["main"]);
  expect(warmer.on.schedule).toBeDefined();
  expect(warmer.on.workflow_dispatch).toBeDefined();
  expect(Object.keys(warmer.on).sort()).toEqual(["push", "schedule", "workflow_dispatch"]);

  const warmerCaches = (jobName: string) =>
    (warmer.jobs[jobName].steps.filter(s => s.uses?.startsWith("Swatinem/rust-cache@")).map(s => s.with) ?? []);
  const releaseCaches = (jobName: string) =>
    (jobs[jobName].steps.filter(s => s.uses?.startsWith("Swatinem/rust-cache@")).map(s => s.with) ?? []);

  for (const job of ["build-macos", "build-linux"] as const) {
    expect(releaseCaches(job)).toEqual([]);
    expect(warmer.jobs[job]).toBeUndefined();
  }
  expect(Object.keys(warmer.jobs).sort()).toEqual(["desktop", "desktop-build"]);

  const desktopRelease = releaseCaches("desktop");
  expect(desktopRelease).toHaveLength(1);
  expect(desktopRelease[0]).toMatchObject({
    "shared-key": "release-desktop-${{ matrix.target }}",
    "save-if": false,
  });
  expect(String(desktopRelease[0]?.workspaces ?? "")).toContain("desktop/src-tauri -> target");
  expect(warmerCaches("desktop")[0]).toMatchObject({ "shared-key": "release-desktop-${{ matrix.target }}" });

  const desktopBuildRelease = releaseCaches("desktop-build");
  expect(desktopBuildRelease).toHaveLength(1);
  expect(desktopBuildRelease[0]).toMatchObject({
    "shared-key": "release-desktop-${{ matrix.target }}",
    "save-if": false,
  });
  expect(String(desktopBuildRelease[0]?.workspaces ?? "")).toContain(". -> target");
  expect(String(desktopBuildRelease[0]?.workspaces ?? "")).toContain("desktop/src-tauri -> target");
  expect(warmerCaches("desktop-build")[0]).toMatchObject({ "shared-key": "release-desktop-${{ matrix.target }}" });

  // Each release shared-key matches a warmer job that uses the same runner image and target.
  for (const [job, warmerJob] of [["desktop", "desktop"], ["desktop-build", "desktop-build"]] as const) {
    const key = releaseCaches(job)[0]?.["shared-key"];
    expect(warmerCaches(warmerJob).some(c => c?.["shared-key"] === key)).toBe(true);
    expect(jobs[job].strategy?.matrix.include?.map(e => e.image ?? e.runner)).toEqual(
      warmer.jobs[warmerJob].strategy?.matrix.include?.map(e => e.image ?? e.runner),
    );
  }

  const ci = Bun.YAML.parse(readFileSync(resolve(".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, WorkflowJob>;
  };
  for (const job of Object.values(ci.jobs)) {
    for (const step of job.steps.filter(s => s.uses?.startsWith("Swatinem/rust-cache@"))) {
      expect(step.with?.["save-if"]).toBe("${{ github.ref == 'refs/heads/main' }}");
    }
  }
});

test("a failed required job of a nightly tag opens or comments on the nightly-failure issue", () => {
  const report = jobs["nightly-failure"];
  expect(report).toBeDefined();
  // Every job a tag push runs; desktop-fixture runs only on dispatch dry runs.
  const required = Object.keys(jobs).filter(name => name !== "nightly-failure" && name !== "desktop-fixture");
  expect([...report.needs!].sort()).toEqual(required.sort());
  // verify may fail before it classifies the channel, so the tag name also identifies a nightly.
  expect(report.if).toBe("always() && github.event_name == 'push' && (needs.verify.outputs.channel == 'nightly' || contains(github.ref_name, '-nightly.')) && contains(needs.*.result, 'failure')");
  expect(report.permissions).toEqual({ issues: "write" });
  const reportStep = report.steps.find(s => s.name === "Report failure")!;
  expect(reportStep.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
  // The same open-or-comment script as nightly.yml, so both stages share one issue.
  const nightly = Bun.YAML.parse(readFileSync(resolve(".github/workflows/nightly.yml"), "utf8")) as { jobs: Record<string, WorkflowJob> };
  expect(reportStep.run).toBe(nightly.jobs.nightly.steps.find(s => s.name === "Report failure")!.run);

  const root = tmpDir(), bin = join(root, "bin"), log = join(root, "gh.log");
  mkdirSync(bin);
  const env = { PATH: `${bin}:${process.env.PATH}`, GH_LOG: log, GITHUB_REPOSITORY: "fixture/repo", GITHUB_SERVER_URL: "https://github.example", GITHUB_RUN_ID: "42" };
  const url = "https://github.example/fixture/repo/actions/runs/42";
  writeFileSync(join(bin, "gh"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GH_LOG"\nif test "$1 $2" = "issue list"; then printf \'12\\n\'; fi\n', { mode: 0o755 });
  expect(run(reportStep.run!, root, env).exitCode).toBe(0);
  expect(readFileSync(log, "utf8").trim().split("\n")[1]).toBe(`issue comment 12 --repo fixture/repo --body Nightly failed again: ${url}`);
  writeFileSync(log, "");
  writeFileSync(join(bin, "gh"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GH_LOG"\n', { mode: 0o755 });
  expect(run(reportStep.run!, root, env).exitCode).toBe(0);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  expect(calls[2]).toStartWith("issue create --repo fixture/repo --title Nightly build failed --label nightly-failure --body ");
  expect(calls[2]).toContain(url);
});
