import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREPARE_RECOVER_SCRIPT, PREPARE_SCRIPT, prepareRecoverArgv } from "../plugins/pacer-ssh/probe";
import { SCRIPTS } from "../src/remote/scripts";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pacer-prepare-recover-"));
  const repo = join(home, "repo"), bin = join(home, "bin"), fetchLog = join(home, "fetch.log");
  mkdirSync(repo); mkdirSync(bin);
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git is required for PREPARE recovery fixture");
  writeFileSync(join(bin, "git"), "#!/bin/sh\ncase \" $* \" in *\" fetch \"*) echo fetch >> \"$PREPARE_FETCH_LOG\";; esac\nexec \"$REAL_GIT\" \"$@\"\n", { mode: 0o700 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`,
    REAL_GIT: realGit, PREPARE_FETCH_LOG: fetchLog };
  const command = (argv: string[], extraEnv: Record<string, string> = {}) => {
    const result = Bun.spawnSync(argv, { env: { ...env, ...extraEnv }, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode ?? 1, stdout: Buffer.from(result.stdout).toString(),
      stderr: Buffer.from(result.stderr).toString() };
  };
  const git = (...args: string[]) => {
    const result = command([realGit, "-C", repo, ...args]);
    if (result.code) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q"); git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("checkout", "-qb", "main");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git("add", "base.txt"); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD"), task = "t-20261027-120000-abcd", tag = "repo-12345678";
  const args = [repo, tag, task, base, "main", "1"];
  const worktree = join(home, ".pacer-remote", "worktrees", tag, `${task}-1`);
  const run = (script: string) => command(["sh", "-c", script, "pacer-prepare", ...args]);
  const runAsHome = (script: string, alternateHome: string) =>
    command(["sh", "-c", script, "pacer-prepare", ...args], { HOME: alternateHome });
  const fetches = () => existsSync(fetchLog) ? readFileSync(fetchLog, "utf8").trim().split("\n").length : 0;
  return { home, repo, worktree, base, task, args, run, runAsHome, git, command, fetches,
    cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("PREPARE recovery is read-only for the exact clean worktree and base", () => {
  const f = fixture();
  try {
    expect(PREPARE_RECOVER_SCRIPT).toBe(SCRIPTS.PREPARE_RECOVER);
    expect(prepareRecoverArgv("box", "/tmp/private/cm-%C", f.args)[0]).toBe("ssh");
    expect(() => prepareRecoverArgv("box", "/tmp/private/cm-%C", ["../repo", ...f.args.slice(1)])).toThrow();
    const first = f.run(PREPARE_SCRIPT);
    expect(first.code).toBe(0);
    const before = f.fetches();
    const recovered = f.run(PREPARE_RECOVER_SCRIPT);
    expect(recovered.code).toBe(0);
    expect(recovered.stdout).toBe(first.stdout);
    expect(f.fetches()).toBe(before);
    expect(f.git("-C", f.worktree, "rev-parse", "HEAD")).toBe(f.base);
  } finally { f.cleanup(); }
});

test("PREPARE recovery refuses missing, partial, dirty and advanced worktrees", () => {
  const f = fixture();
  try {
    expect(f.run(PREPARE_RECOVER_SCRIPT).code).not.toBe(0);
    expect(f.run(PREPARE_SCRIPT).code).toBe(0);
    const before = f.fetches();
    writeFileSync(join(f.worktree, "dirty.txt"), "dirty\n");
    expect(f.run(PREPARE_RECOVER_SCRIPT).code).not.toBe(0);
    rmSync(join(f.worktree, "dirty.txt"));
    f.command([Bun.which("git")!, "-C", f.worktree, "commit", "--allow-empty", "-qm", "advanced"]);
    expect(f.run(PREPARE_RECOVER_SCRIPT).code).not.toBe(0);
    f.git("worktree", "remove", "--force", f.worktree);
    expect(f.run(PREPARE_RECOVER_SCRIPT).code).not.toBe(0);
    expect(f.fetches()).toBe(before);
  } finally { f.cleanup(); }
});

test("PREPARE recovery refuses a foreign checkout at the expected path", () => {
  const f = fixture();
  try {
    mkdirSync(f.worktree, { recursive: true });
    const foreign = f.command([Bun.which("git")!, "-C", f.worktree, "init", "-q"]);
    expect(foreign.code).toBe(0);
    expect(f.run(PREPARE_RECOVER_SCRIPT).code).not.toBe(0);
    expect(f.fetches()).toBe(0);
  } finally { f.cleanup(); }
});

test("PREPARE recovery refuses branch drift and a symlink at the expected path", () => {
  const f = fixture();
  try {
    expect(f.run(PREPARE_SCRIPT).code).toBe(0);
    const changed = f.command([Bun.which("git")!, "-C", f.worktree, "checkout", "-qb", "other"]);
    expect(changed.code).toBe(0);
    expect(f.run(PREPARE_RECOVER_SCRIPT).code).not.toBe(0);
    f.git("worktree", "remove", "--force", f.worktree);
    symlinkSync(f.repo, f.worktree);
    expect(f.run(PREPARE_RECOVER_SCRIPT).code).not.toBe(0);
  } finally { f.cleanup(); }
});

test("PREPARE recovery accepts a symlinked HOME when Git records its canonical worktree", () => {
  const f = fixture();
  try {
    const alias = join(f.home, "home-alias");
    symlinkSync(f.home, alias);
    const first = f.runAsHome(PREPARE_SCRIPT, alias);
    expect(first.code).toBe(0);
    const recovered = f.runAsHome(PREPARE_RECOVER_SCRIPT, alias);
    expect(recovered.code).toBe(0);
    expect(recovered.stdout).toBe(first.stdout);
  } finally { f.cleanup(); }
});
