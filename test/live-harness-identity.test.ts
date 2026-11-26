import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { terminalEnv } from "../src/exec/login-env";
import { environmentScript, installShim, launch, sandboxEnv, type Session } from "../scripts/live/core";
import { executorRefusal, guardedChildCwd, guardedChildEnv } from "../scripts/live/guard";
import { tmpDir } from "./helpers";

function fixture(): Session {
  const root = join(tmpDir(), "sandbox");
  for (const path of ["", "home", "bin", "repo", "evidence", "logs"]) mkdirSync(join(root, path), { recursive: true });
  return { id: "sandbox", root, pid: 12345, port: 49672, createdAt: "2026-10-18T00:00:00Z" };
}
const checkout = join(import.meta.dir, "..");
const executable = (path: string, body: string) => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o700); };

/** What a process the sandbox service launched inherits: the service environment plus its attempt identity. */
function sandboxChild(session: Session, identity: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...sandboxEnv(session, { PATH: process.env.PATH }), ...identity };
}
function identity(session: Session): Record<string, string> {
  const run = join(session.root, "home/runs/t-1/1");
  return {
    PACER_ROLE: "executor", PACER_TASK_ID: "t-1", PACER_WORK_GRANT: "pwg_x", PACER_RUN_GRANT: "prg_x", PACER_RUN_ID: "run-1", PACER_TURN_ID: "turn-1",
    PACER_ENFORCEMENT_MODE: "strict", PACER_ENFORCEMENT_TOKEN: "pet_x",
    PACER_CANARY_MARKER: join(realpathSync(tmpdir()), "pacer-control-canary-x", "denied-Agent"),
    PACER_GUARD_FAILURE_MARKER: join(session.root, "home/guard-failures/t-1-1"),
    PACER_RUN_DIR: run, PACER_REPORT_TOKEN: "report", PACER_TRANSCRIPT_REPORT: join(run, "transcript-report.md"),
    PACER_PLANNER_SESSION: "claude-code:s-1", PACER_CALLER_RESUME: "t-1",
  };
}
const kept = (env: NodeJS.ProcessEnv, from: Record<string, string>) => Object.keys(from).filter(key => env[key] === from[key]);

describe("live guard: identity of sandbox-launched processes", () => {
  test("a sandbox-launched process keeps its identity, with the sandbox's own home, port and CLI", () => {
    const session = fixture(), own = identity(session);
    const env = guardedChildEnv(session, ["step", "result"], sandboxChild(session, own));
    expect(kept(env, own)).toEqual(Object.keys(own));
    expect(env.PACER_HOME).toBe(join(session.root, "home"));
    expect(env.PACER_PORT).toBe("49672");
    expect(env.PACER_BIN).toBe(join(session.root, "bin/pacer"));
  });
  test("a symlinked spelling of the sandbox home is still the sandbox home", () => {
    const session = fixture(), link = join(tmpDir(), "home-link");
    symlinkSync(join(session.root, "home"), link);
    const env = guardedChildEnv(session, ["status"], { ...sandboxChild(session, { PACER_TASK_ID: "t-1" }), PACER_HOME: link });
    expect(env.PACER_TASK_ID).toBe("t-1");
    expect(env.PACER_HOME).toBe(join(session.root, "home"));
  });
  test("outer, foreign-home and unmarked identities are dropped", () => {
    const session = fixture(), other = fixture(), own = identity(session);
    const origins: NodeJS.ProcessEnv[] = [
      { ...own },
      { ...own, PACER_HOME: join(tmpDir(), "elsewhere") },
      { ...sandboxChild(session, own), PACER_HOME: join(other.root, "home") },
      { ...sandboxChild(other, own) },
      // An outer session that sourced env.sh has the sandbox home but was not launched by the sandbox.
      { ...own, PACER_HOME: join(session.root, "home") },
      { ...sandboxChild(session, own), PACER_HOME: undefined },
    ];
    for (const inherited of origins) {
      const env = guardedChildEnv(session, ["status"], inherited);
      expect(Object.keys(own).filter(key => env[key] !== undefined)).toEqual([]);
      expect(env.PACER_HOME).toBe(join(session.root, "home"));
    }
  });
  test("the shell environment script does not carry the sandbox launch mark", () => {
    const session = fixture();
    const exported = Object.fromEntries([...environmentScript(session).matchAll(/^export (\w+)='(.*)'$/gm)].map(match => [match[1], match[2]]));
    const env = guardedChildEnv(session, ["status"], { ...exported, PACER_ROLE: "executor", PACER_WORK_GRANT: "pwg_outer" });
    expect(env.PACER_ROLE).toBeUndefined();
    expect(env.PACER_WORK_GRANT).toBeUndefined();
  });
  test("settings outside the identity list are not carried over even for a sandbox process", () => {
    const session = fixture();
    const env = guardedChildEnv(session, ["status"], sandboxChild(session, { PACER_AUTH_TOKEN: "a", PACER_HOST_SOCKET: "/x", PACER_API: "inprocess", PACER_ALLOW_REAL_INSTALL: "1" }));
    for (const key of ["PACER_AUTH_TOKEN", "PACER_HOST_SOCKET", "PACER_API", "PACER_ALLOW_REAL_INSTALL"]) expect(env[key]).toBeUndefined();
  });
  test("identity paths that leave the sandbox home are dropped", () => {
    const session = fixture(), outside = tmpDir();
    symlinkSync(outside, join(session.root, "home/escape"));
    symlinkSync(join(outside, "missing"), join(session.root, "home/dangling"));
    for (const path of [join(outside, "runs/t-1/1"), join(session.root, "home/../repo/x"), join(session.root, "home/escape/runs/t-1/1"), join(session.root, "home/dangling"), "relative/run"]) {
      const env = guardedChildEnv(session, ["report"], sandboxChild(session, { PACER_TASK_ID: "t-1", PACER_RUN_DIR: path, PACER_TRANSCRIPT_REPORT: path, PACER_GUARD_FAILURE_MARKER: path, PACER_CANARY_MARKER: path }));
      expect([path, env.PACER_RUN_DIR, env.PACER_TRANSCRIPT_REPORT, env.PACER_GUARD_FAILURE_MARKER, env.PACER_CANARY_MARKER]).toEqual([path, undefined, undefined, undefined, undefined]);
      expect(env.PACER_TASK_ID).toBe("t-1");
    }
  });
});

describe("live guard: a sandbox orchestrator answers questions", () => {
  const orchestrator = { PACER_ROLE: "orchestrator", PACER_TASK_ID: "t-orch" };
  test("only a sandbox-launched orchestrator may answer a question, and still not delegate", () => {
    expect(executorRefusal(["answer", "q_abc", "yes"], orchestrator, true)).toBeUndefined();
    expect(executorRefusal(["answer", "q_abc", "yes"], orchestrator)).toContain("cannot delegate onward");
    expect(executorRefusal(["answer", "t-1", "yes"], orchestrator, true)).toContain("cannot delegate onward");
    expect(executorRefusal(["answer", "--json", "t-1", "q_abc"], orchestrator, true)).toContain("cannot delegate onward");
    expect(executorRefusal(["answer", "q_abc", "yes"], { PACER_ROLE: "executor", PACER_TASK_ID: "t-1" }, true)).toContain("cannot delegate onward");
    for (const args of [["delegate", "--goal", "x"], ["dispatch", "child"], ["retry", "t-1"], ["_run", "t-1"], ["api", "call", "task.answer"]]) {
      expect(executorRefusal(args, orchestrator, true)).toContain("cannot delegate onward");
    }
  });
  test("the executable guard admits the answer only from the sandbox", () => {
    const session = fixture(), file = join(session.root, "session.json");
    writeFileSync(file, JSON.stringify(session));
    const guard = (env: NodeJS.ProcessEnv, ...args: string[]) => Bun.spawnSync([process.execPath, "scripts/live/guard.ts", file, ...args], { cwd: checkout, env });
    const inside = sandboxChild(session, orchestrator);
    expect(guard(inside, "answer", "q_abc", "yes").exitCode).not.toBe(3);
    expect(guard(inside, "delegate", "--goal", "x").exitCode).toBe(3);
    expect(guard({ ...process.env, ...orchestrator }, "answer", "q_abc", "yes").exitCode).toBe(3);
  }, 30000);
  test("the strict native-child guard writes the canary marker through the sandbox shim", () => {
    const session: Session = { ...fixture(), tmp: realpathSync(tmpDir()) }, file = join(session.root, "session.json");
    writeFileSync(file, JSON.stringify(session));
    const canary = join(session.tmp!, "pacer-control-canary-test");
    mkdirSync(canary);
    const marker = join(canary, "denied-Agent");
    const child = Bun.spawnSync([process.execPath, "scripts/live/guard.ts", file, "guard", "--planner", "claude-code"], {
      cwd: checkout, stdin: new Blob([JSON.stringify({ tool_name: "Agent", tool_input: {} })]),
      env: sandboxChild(session, { PACER_ROLE: "executor", PACER_ENFORCEMENT_MODE: "strict", PACER_ENFORCEMENT_TOKEN: `pet_${"0".repeat(64)}`, PACER_CANARY_MARKER: marker }),
    });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toContain('"deny"');
    expect(readFileSync(marker, "utf8")).toBe("native-child.denied");
  }, 30000);
});

describe("live sandbox: executors do not read the login shell", () => {
  test("the login environment is off unless the caller chose otherwise", () => {
    const session = fixture();
    for (const inherited of [{}, { PACER_LOGIN_ENV: "" }]) expect(sandboxEnv(session, inherited).PACER_LOGIN_ENV).toBe("off");
    expect(sandboxEnv(session, { PACER_LOGIN_ENV: "on" }).PACER_LOGIN_ENV).toBe("on");
    expect(environmentScript(session)).toContain("export PACER_LOGIN_ENV=");
  });
  test("a launched sandbox process resolves the sandbox codex ahead of the login profile's", async () => {
    const session = fixture(), profile = tmpDir(), shell = join(profile, "login-shell"), out = join(session.root, "env.json");
    executable(join(session.root, "bin/codex"), "echo sandbox");
    executable(join(profile, "codex"), "echo real");
    executable(shell, `printf '__PACER_LOGIN_ENV__\\nPATH=${profile}:/usr/bin:/bin\\0'`);
    const previous = process.env.PACER_LOGIN_ENV;
    delete process.env.PACER_LOGIN_ENV;
    try {
      launch(session, [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(out + ".tmp")}, JSON.stringify(process.env)); require("node:fs").renameSync(${JSON.stringify(out + ".tmp")}, ${JSON.stringify(out)})`], "probe.log", { SHELL: shell });
      for (const deadline = Date.now() + 10000; !existsSync(out) && Date.now() < deadline;) await Bun.sleep(25);
      const service = JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
      const found = await terminalEnv(service, { cwd: dirname(shell) });
      expect(Bun.which("codex", { PATH: found.env.PATH })).toBe(join(session.root, "bin/codex"));
    } finally {
      if (previous !== undefined) process.env.PACER_LOGIN_ENV = previous;
    }
  }, 30000);
});

describe("live guard: working directory", () => {
  test("a caller inside the sandbox home or repo keeps its directory; any other runs in the sandbox repo", () => {
    const session = fixture(), repo = join(session.root, "repo"), outside = tmpDir();
    const worktree = join(session.root, "home/worktrees/repo-1/t-1/sub");
    mkdirSync(worktree, { recursive: true });
    for (const inside of [worktree, join(session.root, "home"), repo]) expect(guardedChildCwd(session, inside)).toBe(realpathSync(inside));
    symlinkSync(outside, join(session.root, "home/escape"));
    mkdirSync(join(session.root, "home-other"));
    for (const other of [outside, checkout, session.root, join(session.root, "logs"), join(session.root, "home-other"), join(session.root, "home/escape"), `${repo}/../..`, join(session.root, "home/missing")]) {
      expect([other, guardedChildCwd(session, other)]).toEqual([other, repo]);
    }
  });
  test("the executable guard resolves a task worktree's relative path from that worktree", () => {
    const session = fixture(), file = join(session.root, "session.json");
    writeFileSync(file, JSON.stringify(session));
    const worktree = join(session.root, "home/worktrees/repo-1/t-1");
    mkdirSync(worktree, { recursive: true });
    // An array parses but is not a result object: reaching that refusal proves the file was read.
    writeFileSync(join(worktree, "result.json"), "[]");
    const child = Bun.spawnSync([process.execPath, join(checkout, "scripts/live/guard.ts"), file, "step", "result", "--file", "result.json"], {
      cwd: worktree, env: sandboxChild(session, { PACER_ROLE: "executor", PACER_TASK_ID: "t-1" }),
    });
    const error = child.stderr.toString();
    expect(error).toContain("must carry a JSON object");
  }, 30000);
  test("git does not climb from a sandbox folder into a repository outside the sandbox", () => {
    const outer = tmpDir(), root = join(outer, "sandbox"), session: Session = { ...fixture(), root };
    mkdirSync(join(root, "home/runs"), { recursive: true });
    expect(Bun.spawnSync(["git", "init", "-q", outer]).exitCode).toBe(0);
    const found = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: join(root, "home/runs"), env: guardedChildEnv(session, ["status"], { PATH: process.env.PATH }) });
    expect(found.exitCode).not.toBe(0);
  });
});

describe("live guard: confinement", () => {
  const paths = ["PACER_RUN_DIR", "PACER_TRANSCRIPT_REPORT", "PACER_GUARD_FAILURE_MARKER"] as const;
  /** Runs `body` with `directory` as the working directory, so a relative path would resolve inside it. */
  function from<T>(directory: string, body: () => T): T {
    const previous = process.cwd();
    process.chdir(directory);
    try { return body(); } finally { process.chdir(previous); }
  }
  test("a `..` after a symlink cannot leave the home, however it reads lexically", () => {
    const session = fixture(), home = join(session.root, "home"), outside = tmpDir();
    symlinkSync(outside, join(home, "link"));
    mkdirSync(join(home, "runs"));
    for (const path of [`${home}/link/../runs`, `${home}/link/..`, `${home}/runs/../runs`]) {
      const env = guardedChildEnv(session, ["report"], sandboxChild(session, { PACER_RUN_DIR: path, PACER_TRANSCRIPT_REPORT: path, PACER_GUARD_FAILURE_MARKER: path }));
      expect([path, ...paths.map(key => env[key])]).toEqual([path, undefined, undefined, undefined]);
      expect([path, guardedChildCwd(session, path)]).toEqual([path, join(session.root, "repo")]);
    }
    const forged = guardedChildEnv(session, ["status"], { ...sandboxChild(session, { PACER_TASK_ID: "t-1" }), PACER_HOME: `${home}/link/../home` });
    expect(forged.PACER_TASK_ID).toBeUndefined();
  });
  test("a relative identity path is dropped even when it would resolve inside the home", () => {
    const session = fixture(), home = join(session.root, "home");
    mkdirSync(join(home, "runs"));
    const env = from(home, () => guardedChildEnv(session, ["report"], sandboxChild(session, { PACER_RUN_DIR: "runs", PACER_TRANSCRIPT_REPORT: "runs/report.md", PACER_GUARD_FAILURE_MARKER: "runs/marker" })));
    expect(paths.map(key => env[key])).toEqual([undefined, undefined, undefined]);
  });
  test("the home itself is not a run directory", () => {
    const session = fixture();
    expect(guardedChildEnv(session, ["report"], sandboxChild(session, { PACER_RUN_DIR: join(session.root, "home") })).PACER_RUN_DIR).toBeUndefined();
  });
  test("a canary marker is kept only as a probe's marker under the sandbox's temporary directory", () => {
    const tmp = realpathSync(tmpDir()), outside = realpathSync(tmpDir()), session: Session = { ...fixture(), tmp };
    const probe = join(tmp, "pacer-control-canary-a");
    mkdirSync(probe);
    mkdirSync(join(outside, "pacer-control-canary-b"));
    symlinkSync(join(outside, "pacer-control-canary-b"), join(tmp, "pacer-control-canary-link"));
    symlinkSync(join(outside, "missing"), join(probe, "denied-dangling"));
    const keptMarker = (marker: string) => guardedChildEnv(session, ["guard"], sandboxChild(session, { PACER_CANARY_MARKER: marker })).PACER_CANARY_MARKER;
    expect(keptMarker(join(probe, "denied-Agent"))).toBe(join(probe, "denied-Agent"));
    for (const marker of [
      join(outside, "pacer-control-canary-b/denied-Agent"),
      join(tmp, "pacer-control-canary-link/denied-Agent"),
      join(probe, "denied-dangling"),
      `${tmp}/pacer-control-canary-link/../pacer-control-canary-a/denied-Agent`,
      join(tmp, "other/denied-Agent"),
      join(tmp, "denied-Agent"),
      join(probe, "allowed-Agent"),
    ]) expect([marker, keptMarker(marker)]).toEqual([marker, undefined]);
    expect(from(tmp, () => keptMarker("pacer-control-canary-a/denied-Agent"))).toBeUndefined();
  });
  test("a session without a recorded temporary directory uses the current one", () => {
    const session = fixture(), marker = join(realpathSync(tmpdir()), "pacer-control-canary-c/denied-Task");
    expect(guardedChildEnv(session, ["guard"], sandboxChild(session, { PACER_CANARY_MARKER: marker })).PACER_CANARY_MARKER).toBe(marker);
  });
  test("the assistant MCP server receives only a home inside the sandbox", () => {
    const session = fixture(), inside = join(session.root, "home/runs/assistant/turn-1"), outside = tmpDir();
    symlinkSync(outside, join(session.root, "home/link"));
    const pass = (value: string) => guardedChildEnv(session, ["mcp", "--assistant"], { PACER_HOME: value, PACER_ASSISTANT_HOME: value });
    for (const value of [inside, join(session.root, "home")]) expect([pass(value).PACER_HOME, pass(value).PACER_ASSISTANT_HOME]).toEqual([value, value]);
    for (const value of [outside, join(session.root, "home/link/turn"), `${session.root}/home/link/..`, "relative"]) {
      expect([value, pass(value).PACER_HOME, pass(value).PACER_ASSISTANT_HOME]).toEqual([value, join(session.root, "home"), undefined]);
    }
  });
});

describe("live guard: files in the caller's directory", () => {
  /** A sandbox whose real shim runs from a task worktree holding the given files. */
  function hostile(files: Record<string, string>) {
    const session = fixture(), worktree = join(session.root, "home/worktrees/repo-1/t-1");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(session.root, "session.json"), JSON.stringify(session));
    installShim(session);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(worktree, name), body);
    const pacer = (env: NodeJS.ProcessEnv, ...args: string[]) => Bun.spawnSync([join(session.root, "bin/pacer"), ...args], { cwd: worktree, env });
    return { session, worktree, pacer };
  }
  test("a .env cannot forge the sandbox mark", () => {
    const { session, worktree, pacer } = hostile({});
    writeFileSync(join(worktree, ".env"), `PACER_LIVE_SANDBOX=${session.root}\n`);
    const outer = { PATH: process.env.PATH, PACER_HOME: join(session.root, "home"), PACER_ROLE: "orchestrator", PACER_TASK_ID: "t-outer" };
    expect(pacer(outer, "answer", "q_abc", "yes").exitCode).toBe(3);
  }, 30000);
  test("a .env cannot set variables on the guarded CLI", () => {
    const { pacer } = hostile({ ".env": "PACER_ROLE=orchestrator\n", ".env.local": "PACER_RUN_GRANT=prg_forged\n" });
    const child = pacer({ PATH: process.env.PATH }, "tasks");
    expect(child.stderr.toString()).not.toContain("orchestrator role only allows");
  }, 30000);
  test("a bunfig.toml preload runs in neither the guard nor the guarded CLI", () => {
    const { worktree, pacer } = hostile({
      "bunfig.toml": 'preload = ["./preload.ts"]\n',
      "preload.ts": 'require("node:fs").appendFileSync(`${import.meta.dir}/preloaded`, `${process.argv[1]}\\n`);\n',
    });
    pacer({ PATH: process.env.PATH }, "tasks");
    expect(existsSync(join(worktree, "preloaded")) ? readFileSync(join(worktree, "preloaded"), "utf8") : "").toBe("");
  }, 30000);
  test("the Rust front door's core ignores them too", () => {
    const session: Session = { ...fixture(), frontDoor: "rust" };
    const argv = JSON.parse(guardedChildEnv(session, ["tasks"], {}).PACER_CORE_ARGV!) as string[];
    expect(argv).toEqual([process.execPath, "--no-env-file", "--config=/dev/null", join(checkout, "src/cli.ts")]);
  });
});
