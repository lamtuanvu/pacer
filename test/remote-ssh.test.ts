import { expect, test } from "bun:test";
import { existsSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { defaultRun } from "../src/ctx";
import { SCRIPTS } from "../src/remote/scripts";
import { controlDir, sshArgv } from "../src/remote/ssh";
import type { Ctx } from "../src/types";
import { fakeCtx, fakeSshEnv, realRun, tmpDir } from "./helpers";

const host = { alias: "box", ssh: "box-ssh", repos: {}, maxTasks: 2, accounts: {} };

/** Run the pinned argv against the fake SSH host; production spawns it only through pacer-ssh. */
async function runPinned(ctx: Ctx, script: string, args: string[]) {
  const result = await realRun(sshArgv(ctx, host, script, args), 60_000, { env: { ...process.env, ...ctx.env } });
  const at = result.stdout.search(/^__PACER_BEGIN__\n/m);
  return { ...result, stdout: at >= 0 ? result.stdout.slice(at + "__PACER_BEGIN__\n".length) : "" };
}

test("sshArgv is fixed: options, alias, bash -lc and quoted args", () => {
  const ctx = fakeCtx();
  const argv = sshArgv(ctx, host, SCRIPTS.PROBE, ["it's"]);
  expect(argv.slice(0, 2)).toEqual(["ssh", "-o"]);
  expect(argv).toContain("BatchMode=yes");
  for (const option of ["ConnectTimeout=10", "ServerAliveInterval=15", "ServerAliveCountMax=2", "ControlMaster=auto", "ControlPersist=60"]) {
    expect(argv).toContain(option);
  }
  expect(argv).toContain(`ControlPath=${join(controlDir(ctx), "cm-%C")}`);
  const i = argv.indexOf("--");
  expect(argv[i + 1]).toBe("box-ssh");
  expect(argv[i + 2]).toMatch(/^bash -lc '.*' pacer 'it'\\''s'$/s);
  expect(() => sshArgv(ctx, host, "rm -rf ~", [])).toThrow();
});

test("PROBE reports tools from the host's login shell", async () => {
  const hostHome = tmpDir(), log = join(tmpDir(), "ssh.log"), ctx = fakeCtx({ run: realRun });
  ctx.env = fakeSshEnv(hostHome, log);
  const r = await runPinned(ctx, SCRIPTS.PROBE, []);
  expect(r.stdout).toMatch(/^git=git version /m);
  expect(r.stdout).toContain(`home=${hostHome}`);
  for (const tool of ["codex", "claude", "setsid"]) expect(r.stdout).toMatch(new RegExp(`^${tool}=.*$`, "m"));
});

test("controlDir creates a private SSH socket directory", () => {
  const ctx = fakeCtx();
  expect(statSync(controlDir(ctx)).mode & 0o777).toBe(0o700);
});

test("long pacer homes still produce a usable private SSH control path", () => {
  if (process.platform === "win32") return;
  const ctx = fakeCtx();
  ctx.pacerHome = join(ctx.pacerHome, "nested".repeat(20));
  const argv = sshArgv(ctx, host, SCRIPTS.PROBE, []);
  const controlPath = argv.find(arg => arg.startsWith("ControlPath="))?.slice("ControlPath=".length);
  expect(controlPath).toBeDefined();
  expect(Buffer.byteLength(controlPath!.replace("%C", "f".repeat(40)))).toBeLessThan(104);
  expect(statSync(controlDir(ctx)).mode & 0o777).toBe(0o700);
});

test("short SSH socket directory refuses a pre-existing symlink", () => {
  if (process.platform === "win32") return;
  const ctx = fakeCtx();
  ctx.pacerHome = join(ctx.pacerHome, "nested".repeat(20));
  const dir = controlDir(ctx);
  rmSync(dir, { recursive: true });
  symlinkSync(tmpDir(), dir);
  try { expect(() => controlDir(ctx)).toThrow("not private and owned"); }
  finally { unlinkSync(dir); }
});

test("defaultRun carries stdin and env to a real process", async () => {
  const stdin = "quotes '\" $(id) `id`\nline2\n";
  const result = await defaultRun(["sh", "-c", 'printf "%s\\n" "$PACER_STDIN_TEST"; cat'], 5000, {
    stdin, env: { ...process.env, PACER_STDIN_TEST: "present" },
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`present\n${stdin}`);
});

test("quoted arguments cannot execute shell substitutions", async () => {
  const hostHome = tmpDir(), log = join(tmpDir(), "ssh.log"), ctx = fakeCtx({ run: realRun });
  ctx.env = fakeSshEnv(hostHome, log);
  const result = await runPinned(ctx, SCRIPTS.PROBE,
    ["it's", '$(touch "$HOME/pwned")', '`touch "$HOME/pwned"`', "line1\nline2"]);
  expect(result.code).toBe(0);
  expect(existsSync(join(hostHome, "pwned"))).toBe(false);
});

test("an unreachable fake host returns SSH's connection refusal", async () => {
  const ctx = fakeCtx({ run: realRun });
  ctx.env = fakeSshEnv(tmpDir(), join(tmpDir(), "ssh.log"), "other box-ssh");
  const result = await runPinned(ctx, SCRIPTS.PROBE, []);
  expect(result.code).toBe(255);
  expect(result.stderr).toContain("ssh: connect to host box-ssh port 22: Connection refused");
});
