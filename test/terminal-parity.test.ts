import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderCfg } from "../src/config/strategy";
import { runAttempt } from "../src/exec/direct";
import { clearTerminalEnvCache, terminalEnv } from "../src/exec/login-env";
import { executorEnv } from "../src/exec/process";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx, fakeLoginShell, tmpDir } from "./helpers";

afterEach(clearTerminalEnvCache);

// The pacer session must look like the same CLI started from the user's terminal, apart from these.
const PACER_ENV = ["PACER_ROLE", "PACER_TASK_ID", "PACER_HOME"];
const INTERACTIVE_ENV = ["PACER_RUN_DIR", "PACER_TRANSCRIPT_REPORT", "PACER_REPORT_TOKEN", "TERM", "COLORTERM"];
// Set by the /bin/sh fake agent itself, as any shell script would.
const SCRIPT_STATE = new Set(["_", "SHLVL", "OLDPWD"]);

type Agent = "claude-code" | "codex" | "cursor" | "agy" | "opencode";
const BINARY: Record<Agent, string> = {"claude-code": "claude", codex: "codex", cursor: "cursor-agent", agy: "agy", opencode: "opencode"};
const cfg = (agent: Agent, session: "interactive" | "headless"): ProviderCfg =>
  ({id: agent === "opencode" ? "local" : agent, via: agent === "opencode" ? "opencode" : null, session, model: null} as unknown as ProviderCfg);

/** pacer's flags for each agent, given the attempt's paths. The prompt is the last argument (stdin for headless Codex). */
function expectedArgv(agent: Agent, mode: "interactive" | "headless", p: {workdir: string; dir: string; id: string; session?: string}): string[] {
  if (mode === "headless") return {
    "claude-code": ["claude", "-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", "--session-id", p.session!],
    codex: ["codex", "exec", "-C", p.workdir, "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-o", join(p.dir, `${p.id}.codex-last.md`), "-"],
    cursor: ["cursor-agent", "-p", "--output-format", "text", "--force", "--sandbox", "disabled", "--workspace", p.workdir, "--resume", "chat-1"],
    agy: ["agy", "--dangerously-skip-permissions", "--add-dir", p.workdir, "-p"],
    opencode: ["opencode", "run", "--standalone", "--agent", "build", "-m", "", "--auto", "--title", `pacer ${p.id}`],
  }[agent];
  const hook = `/bin/sh '${join(p.dir, "report-hook.sh")}'`;
  return {
    "claude-code": ["claude", "--settings", join(p.dir, "claude-settings.json"), "--dangerously-skip-permissions", "--"],
    codex: ["codex", "--dangerously-bypass-hook-trust",
      ...["PermissionRequest", "Stop", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure"].flatMap(event => ["-c", `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(hook)}}]}]`]),
      "--no-daemon", "-c", `projects={${JSON.stringify(p.workdir)}={trust_level="trusted"}}`, "-C", p.workdir, "--dangerously-bypass-approvals-and-sandbox", "--add-dir", p.dir, "--"],
    cursor: ["cursor-agent", "--force", "--sandbox", "disabled", "--workspace", p.workdir, "--"],
    agy: ["agy", "--dangerously-skip-permissions", "--add-dir", p.workdir, "--prompt-interactive"],
    opencode: ["opencode", "--standalone", "--auto", "--prompt"],
  }[agent];
}

async function launch(agent: Agent, mode: "interactive" | "headless") {
  const root = tmpDir(), profileBin = join(root, "profile-bin"), dump = join(root, "dump"), cli = join(import.meta.dir, "..", "src", "cli.ts");
  mkdirSync(profileBin);
  mkdirSync(dump);
  // The agent is reachable only through the profile's PATH, as with a tool manager.
  const report = mode === "interactive" ? `bun "$PACER_TEST_CLI" report --task "$PACER_TASK_ID" --outcome done --summary parity` : "";
  writeFileSync(join(profileBin, BINARY[agent]), `#!/bin/sh\n[ "$1" = create-chat ] && { echo chat-1; exit 0; }\n[ "$1" = --version ] && { echo "codex-cli 0.164.0"; exit 0; }\n/usr/bin/env -0 > ${JSON.stringify(join(dump, "env"))}\nprintf '%s\\0' "$@" > ${JSON.stringify(join(dump, "argv"))}\n${report}\n`);
  chmodSync(join(profileBin, BINARY[agent]), 0o755);
  const shell = fakeLoginShell(root, `export PATH="${profileBin}:${dirname(process.execPath)}:$PATH" PROFILE_ONLY=from-profile LANG=en_US.UTF-8 HTTPS_PROXY=http://proxy.invalid:3128 PACER_HOME=/profile/must/not/win`);
  const ctx = fakeCtx();
  ctx.env = {PATH: "/usr/bin:/bin", HOME: ctx.home, SHELL: shell, SERVICE_ONLY: "kept", PACER_HOME: ctx.pacerHome, PACER_LOGIN_ENV: "on", PACER_TEST_CLI: cli, PACER_AUTH_TOKEN: "service-secret"};
  ctx.run = async () => ({code: 0, stdout: "codex-cli 0.164.0", stderr: ""});
  const task = createTask(ctx, {brief: {goal: "Parity check", repo: tmpDir()}, kind: null, requestedExecutor: null, timeoutS: 30});
  updateTask(ctx, task.id, t => {t.state = "running";});
  const out = await runAttempt(ctx, cfg(agent, mode), readTask(ctx, task.id)!);
  const run = readTask(ctx, task.id)!.run!;
  const env = Object.fromEntries(readFileSync(join(dump, "env"), "utf8").split("\0").filter(Boolean).map(e => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
  const argv = readFileSync(join(dump, "argv"), "utf8").split("\0").slice(0, -1);
  // The terminal baseline: the same login shell's environment, with pacer's account selection applied.
  const terminal = executorEnv((await terminalEnv(ctx.env, {cwd: ctx.home})).env, {}, task.id);
  return {out, run, env, argv, terminal, id: task.id};
}

for (const agent of ["claude-code", "codex", "cursor", "agy", "opencode"] as Agent[]) {
  for (const mode of ["headless", "interactive"] as const) {
    test(`${agent} ${mode}: argv and environment match the terminal launch plus pacer's overrides`, async () => {
      const {out, run, env, argv, terminal, id} = await launch(agent, mode);
      expect(out.exec.code).toBe(0);
      const flags = expectedArgv(agent, mode, {workdir: run.workdir, dir: run.dir, id, session: run.agentSession?.id});
      const prompted = !(agent === "codex" && mode === "headless");
      expect([BINARY[agent], ...argv.slice(0, prompted ? -1 : undefined)]).toEqual(flags);
      if (prompted) expect(argv.at(-1)).toContain("Parity check");
      // Profile exports and service-only variables arrive unchanged; pacer's own coordinates win.
      expect(env).toMatchObject({PROFILE_ONLY: "from-profile", LANG: "en_US.UTF-8", HTTPS_PROXY: "http://proxy.invalid:3128", SERVICE_ONLY: "kept", PACER_HOME: terminal.PACER_HOME});
      expect(env.PATH).toBe(terminal.PATH!);
      expect(env.PACER_AUTH_TOKEN).toBeUndefined();
      const overrides = new Set([...PACER_ENV, ...(mode === "interactive" ? INTERACTIVE_ENV : []), "PWD"]);
      const changed = Object.keys({...env, ...terminal}).filter(key => !SCRIPT_STATE.has(key) && env[key] !== terminal[key]).sort();
      expect(changed.filter(key => !overrides.has(key))).toEqual([]);
      // The headless /bin/sh wrapper may report the physical path.
      expect(realpathSync(env.PWD)).toBe(realpathSync(run.workdir));
      if (mode === "interactive") expect(env).toMatchObject({TERM: "xterm-256color", COLORTERM: "truecolor", PACER_RUN_DIR: run.dir});
      expect(JSON.parse(readFileSync(join(run.dir, "environment.json"), "utf8"))).toEqual({source: "login-shell", shell: terminal.SHELL});
    }, 30_000);
  }
}
