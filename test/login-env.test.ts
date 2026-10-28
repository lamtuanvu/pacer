import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clearTerminalEnvCache, composeTerminalEnv, LOGIN_ENV_TIMEOUT_MS, parseLoginEnv, terminalEnv, terminalEnvNote } from "../src/exec/login-env";
import type { ExecSpec } from "../src/exec/process";
import { fakeLoginShell, tmpDir } from "./helpers";

afterEach(clearTerminalEnvCache);

test("the login environment is read after the marker and drops the printing shell's own state", () => {
  const out = `motd\n__PACER_LOGIN_ENV__\n${["PATH=/profile/bin:/usr/bin", "MULTI=a\nb", "_=/usr/bin/env", "PWD=/x", "OLDPWD=/y", "SHLVL=2", "BASH_FUNC_f%%=() {", "EMPTY="].join("\0")}\0`;
  expect(parseLoginEnv(out)).toEqual({PATH: "/profile/bin:/usr/bin", MULTI: "a\nb", EMPTY: ""});
  expect(parseLoginEnv("no marker here")).toBeNull();
});

test("composition puts the login environment over the service's and pacer's own variables on top", () => {
  const service = {PATH: "/usr/bin:/bin", HOME: "/sandbox", PACER_HOME: "/sandbox/.pacer", SERVICE_ONLY: "kept", LANG: "C"};
  const login = {PATH: "/profile/bin:/usr/bin:/bin", HOME: "/elsewhere", PACER_HOME: "/wrong", LANG: "en_US.UTF-8", PROFILE_ONLY: "yes"};
  expect(composeTerminalEnv(service, login)).toEqual({PATH: "/profile/bin:/usr/bin:/bin", HOME: "/sandbox", PACER_HOME: "/sandbox/.pacer", SERVICE_ONLY: "kept", LANG: "en_US.UTF-8", PROFILE_ONLY: "yes"});
});

test("a real login shell supplies the profile's exports; pacer tokens never reach the profile", async () => {
  const dir = tmpDir(), seen = join(dir, "seen");
  const shell = fakeLoginShell(dir, `printf '%s' "\${PACER_AUTH_TOKEN-unset}" > ${JSON.stringify(seen)}\nexport PATH="/profile/bin:$PATH" PROFILE_ONLY=from-profile HTTPS_PROXY=http://proxy.invalid:3128`);
  const service = {PATH: "/usr/bin:/bin", HOME: dir, SHELL: shell, SERVICE_ONLY: "kept", PACER_AUTH_TOKEN: "secret", PACER_LOGIN_ENV: "on"};
  const found = await terminalEnv(service, {cwd: dir});
  expect(found).toMatchObject({source: "login-shell", shell});
  expect(found.env).toMatchObject({PATH: "/profile/bin:/usr/bin:/bin", PROFILE_ONLY: "from-profile", HTTPS_PROXY: "http://proxy.invalid:3128", SERVICE_ONLY: "kept", HOME: dir, PACER_AUTH_TOKEN: "secret"});
  expect(found.env.SHLVL).toBeUndefined();
  expect(readFileSync(seen, "utf8")).toBe("unset");
  expect(terminalEnvNote(found)).toBe("");
});

test("the login environment is cached briefly per service environment, then read again", async () => {
  const dir = tmpDir();
  let runs = 0;
  const run = async (spec: ExecSpec) => { runs++; return {code: 0, stdout: `__PACER_LOGIN_ENV__\nPATH=/p${runs}\0`, stderr: "", timedOut: false}; };
  const service = {SHELL: "/bin/sh", PATH: "/usr/bin", PACER_LOGIN_ENV: "on"};
  expect((await terminalEnv(service, {cwd: dir, run, now: 0})).env.PATH).toBe("/p1");
  // Per-attempt pacer tokens do not defeat the cache.
  expect((await terminalEnv({...service, PACER_WORK_GRANT: "pwg_1"}, {cwd: dir, run, now: 1000})).env.PATH).toBe("/p1");
  expect((await terminalEnv({...service, EXTRA: "1"}, {cwd: dir, run, now: 1000})).env.PATH).toBe("/p2");
  expect((await terminalEnv(service, {cwd: dir, run, now: 61_000})).env.PATH).toBe("/p3");
  expect(runs).toBe(3);
});

test("without a usable login shell the service environment is used and the reason recorded", async () => {
  const dir = tmpDir(), service = {PATH: "/usr/bin", SHELL: "/bin/sh", KEEP: "1", PACER_LOGIN_ENV: "on"};
  const cases: [Parameters<typeof terminalEnv>[1]["run"], string][] = [
    [async () => ({code: 0, stdout: "", stderr: "", timedOut: true}), `the login shell did not finish within ${LOGIN_ENV_TIMEOUT_MS / 1000}s`],
    [async () => ({code: 1, stdout: "broken profile", stderr: "secret=value", timedOut: false}), "the login shell exited 1"],
    [async () => ({code: 0, stdout: "", stderr: "", timedOut: false, stdoutOverflow: true}), "the login shell printed too much output"],
    [async () => { throw Error("spawn failed with secret=value"); }, "the login shell could not be started"],
  ];
  for (const [run, reason] of cases) {
    clearTerminalEnvCache();
    const found = await terminalEnv(service, {cwd: dir, run});
    expect(found).toEqual({env: service, source: "service", reason});
    expect(terminalEnvNote(found)).toBe(`executor environment: login shell not used (${reason}); the agent runs with the pacer service's environment\n\n`);
  }
  const off = await terminalEnv({...service, PACER_LOGIN_ENV: "off"}, {cwd: dir});
  expect(off).toEqual({env: {...service, PACER_LOGIN_ENV: "off"}, source: "service", reason: "disabled by PACER_LOGIN_ENV=off"});
  expect(terminalEnvNote(off)).toBe("");
});
