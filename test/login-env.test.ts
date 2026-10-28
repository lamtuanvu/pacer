import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultAccountFolder, recordDefaultFolder, withDefaultFolder } from "../src/exec/account-folder";
import { claudeConfigFile } from "../src/exec/claude-trust";
import { applyFolderTools, clearTerminalEnvCache, composeTerminalEnv, FOLDER_TOOL_TIMEOUT_MS, LOGIN_ENV_TIMEOUT_MS, parseLoginEnv, parseLoginUmask, profileColor, profileKeys, terminalEnv, terminalEnvNote, terminalEnvRecord, terminalUmask, withUmask } from "../src/exec/login-env";
import { execProcess, executorEnv, type ExecSpec } from "../src/exec/process";
import { nativeTerminalEnv } from "../src/session/environment";
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

test("the login umask is read strictly between its marker and the environment, and applied to the child only", async () => {
  expect(parseLoginUmask("motd\n__PACER_LOGIN_UMASK__\n0027\n__PACER_LOGIN_ENV__\nPATH=/x\0")).toBe("0027");
  expect(parseLoginUmask("__PACER_LOGIN_UMASK__\n022\n__PACER_LOGIN_ENV__\n")).toBe("022");
  for (const bad of ["u=rwx,g=rx", "0028", "00227", "", "0022; rm -rf /"]) expect(parseLoginUmask(`__PACER_LOGIN_UMASK__\n${bad}\n__PACER_LOGIN_ENV__\n`)).toBeNull();
  expect(withUmask(["agent", "--flag"], "027")).toEqual(["/bin/sh", "-c", 'umask "$1" && shift && exec "$@"', "pacer-umask", "027", "agent", "--flag"]);
  expect(withUmask(["agent"], "0022; id")).toEqual(["agent"]);
  expect(withUmask(["agent"])).toEqual(["agent"]);
  const before = process.umask();
  const result = await execProcess({argv: withUmask(["/bin/sh", "-c", "umask"], "077"), cwd: tmpDir(), env: {PATH: "/usr/bin:/bin"}, timeoutMs: 5000});
  expect(result.stdout.trim()).toBe("0077");
  expect(process.umask()).toBe(before);
});

test("a profile that sets no valid umask keeps the service's and says why", async () => {
  const dir = tmpDir();
  const run = async () => ({code: 0, stdout: "__PACER_LOGIN_UMASK__\n__PACER_LOGIN_ENV__\nPATH=/p\0", stderr: "", timedOut: false});
  const found = await terminalEnv({SHELL: "/bin/sh", PATH: "/usr/bin", PACER_LOGIN_ENV: "on"}, {cwd: dir, run});
  expect(terminalUmask(found)).toBeUndefined();
  expect(terminalEnvNote(found)).toBe("executor environment: login umask not applied (the login shell printed no valid umask); the agent runs with the pacer service's umask\n\n");
});

test("color flags and account folders count as the user's only when the profile sets them", async () => {
  const dir = tmpDir();
  const service = {PATH: "/usr/bin:/bin", HOME: dir, NO_COLOR: "1", FORCE_COLOR: "3", CLAUDE_CONFIG_DIR: "/service/claude", CODEX_HOME: "/service/codex", PACER_LOGIN_ENV: "on"};
  // The service's values are withheld from the login shell, so a profile that does not set them prints none.
  const quiet = await terminalEnv({...service, SHELL: fakeLoginShell(dir, "true")}, {cwd: dir});
  expect(profileKeys(quiet)).toEqual([]);
  expect(nativeTerminalEnv(quiet.env, profileColor(quiet))).not.toHaveProperty("NO_COLOR");
  expect(nativeTerminalEnv(quiet.env, profileColor(quiet))).not.toHaveProperty("FORCE_COLOR");
  expect(executorEnv(quiet.env, {}, "t", profileKeys(quiet))).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  clearTerminalEnvCache();
  const other = tmpDir();
  const set = await terminalEnv({...service, SHELL: fakeLoginShell(other, `export NO_COLOR=profile CLAUDE_CONFIG_DIR=${other}/claude`)}, {cwd: other});
  expect(profileKeys(set)).toEqual(["NO_COLOR", "CLAUDE_CONFIG_DIR"]);
  const pty = nativeTerminalEnv(set.env, profileColor(set));
  expect(pty.NO_COLOR).toBe("profile");
  expect(pty).not.toHaveProperty("FORCE_COLOR");
  const env = executorEnv(set.env, {}, "t", profileKeys(set));
  expect(env.CLAUDE_CONFIG_DIR).toBe(`${other}/claude`);
  expect(env).not.toHaveProperty("CODEX_HOME");
  // A named account's folder still wins over the profile's.
  expect(executorEnv(set.env, {CLAUDE_CONFIG_DIR: "/accounts/claude1"}, "t", profileKeys(set)).CLAUDE_CONFIG_DIR).toBe("/accounts/claude1");
});

function folderBin(dir: string, scripts: Record<string, string>): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, {recursive: true});
  for (const [name, body] of Object.entries(scripts)) { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); }
  return bin;
}

test("direnv and mise apply for the workdir in order, with direnv's unsets, through fixed argv", async () => {
  const dir = tmpDir(), work = join(dir, "work");
  mkdirSync(work);
  writeFileSync(join(dir, ".envrc"), "export FROM_ENVRC=1\n");
  const bin = folderBin(dir, {
    direnv: `printf '%s ' "$@" > ${JSON.stringify(join(dir, "direnv-argv"))}; pwd > ${JSON.stringify(join(dir, "direnv-cwd"))}; echo '{"FROM_ENVRC":"yes","DROP_ME":null,"SHARED":"direnv","HOME":"/evil","PACER_ROLE":"x"}'`,
    mise: `printf '%s ' "$@" > ${JSON.stringify(join(dir, "mise-argv"))}; echo "{\\"FROM_MISE\\":\\"$FROM_ENVRC\\",\\"SHARED\\":\\"mise\\"}"`,
  });
  const out = await applyFolderTools({PATH: `${bin}:/usr/bin:/bin`, HOME: dir, DROP_ME: "x", PACER_ROLE: "executor"}, work);
  expect(out.folder).toEqual([{tool: "direnv", status: "applied"}, {tool: "mise", status: "applied"}]);
  expect(out.env).toMatchObject({FROM_ENVRC: "yes", FROM_MISE: "yes", SHARED: "mise", HOME: dir, PACER_ROLE: "executor"});
  expect(out.env).not.toHaveProperty("DROP_ME");
  expect(readFileSync(join(dir, "direnv-argv"), "utf8")).toBe("export json ");
  expect(readFileSync(join(dir, "mise-argv"), "utf8")).toBe("env --json ");
  expect(realpathSync(readFileSync(join(dir, "direnv-cwd"), "utf8").trim())).toBe(realpathSync(work));
});

test("a blocked .envrc, an untrusted mise config, a failure or a timeout skip the tool with a reason and no values", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, ".envrc"), "export SECRET=value\n");
  const bin = folderBin(dir, {
    direnv: `echo 'direnv: error ${dir}/.envrc is blocked. Run \`direnv allow\` to approve its content' >&2; exit 1`,
    mise: `echo "mise ERROR Config files in ${dir}/mise.toml are not trusted. SECRET=value" >&2; exit 1`,
  });
  const out = await applyFolderTools({PATH: `${bin}:/usr/bin:/bin`}, dir);
  expect(out.folder).toEqual([
    {tool: "direnv", status: "skipped", reason: ".envrc is not allowed (direnv allow decides)"},
    {tool: "mise", status: "skipped", reason: "the folder's config is not trusted (mise trust decides)"},
  ]);
  expect(out.env).not.toHaveProperty("SECRET");
  const run = async (spec: ExecSpec) => spec.argv[1] === "export" ? {code: 0, stdout: "", stderr: "", timedOut: true} : {code: 0, stdout: "not json", stderr: "", timedOut: false};
  const failed = await applyFolderTools({PATH: `${bin}:/usr/bin:/bin`}, dir, run);
  expect(failed.folder).toEqual([
    {tool: "direnv", status: "skipped", reason: `did not finish within ${FOLDER_TOOL_TIMEOUT_MS / 1000}s`},
    {tool: "mise", status: "skipped", reason: "printed output that is not an environment"},
  ]);
  // Without an .envrc direnv is not run; without the tools on PATH nothing is.
  const plain = tmpDir();
  expect((await applyFolderTools({PATH: `${bin}:/usr/bin:/bin`}, plain, async () => ({code: 3, stdout: "", stderr: "", timedOut: false}))).folder).toEqual([{tool: "mise", status: "skipped", reason: "exited 3"}]);
  expect((await applyFolderTools({PATH: "/usr/bin:/bin"}, dir)).folder).toEqual([]);
});

test("per-folder tools run for every launch and their skip reasons reach the note and the record", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, ".envrc"), "");
  const bin = folderBin(dir, {direnv: "echo blocked >&2; exit 1"});
  let calls = 0;
  const run = async (spec: ExecSpec) => {
    if (spec.argv[1] === "export") { calls++; return {code: 1, stdout: "", stderr: "direnv: error .envrc is blocked", timedOut: false}; }
    return {code: 0, stdout: `__PACER_LOGIN_UMASK__\n0022\n__PACER_LOGIN_ENV__\nPATH=${bin}:/usr/bin\0`, stderr: "", timedOut: false};
  };
  const service = {SHELL: "/bin/sh", PATH: "/usr/bin", PACER_LOGIN_ENV: "on"};
  const found = await terminalEnv(service, {cwd: dir, workdir: dir, run});
  await terminalEnv(service, {cwd: dir, workdir: dir, run});
  expect(calls).toBe(2);
  expect(terminalUmask(found)).toBe("0022");
  expect(terminalEnvNote(found)).toBe("executor environment: direnv not applied (.envrc is not allowed (direnv allow decides))\n\n");
  expect(terminalEnvRecord(found)).toEqual({source: "login-shell", shell: "/bin/sh", umask: "login", profileKeys: [], folder: [{tool: "direnv", status: "skipped", reason: ".envrc is not allowed (direnv allow decides)"}]});
});

test("the default account's folder follows the profile for trust, transcripts and usage readers", () => {
  const ctx = {pacerHome: tmpDir(), home: tmpDir()};
  expect(defaultAccountFolder(ctx, "claude")).toBe(join(ctx.home, ".claude"));
  recordDefaultFolder(ctx, "claude-code", {}, {CLAUDE_CONFIG_DIR: "/profile/claude"});
  // A named account's run does not change the default account's folder.
  recordDefaultFolder(ctx, "claude-code", {CLAUDE_CONFIG_DIR: "/accounts/claude1"}, {CLAUDE_CONFIG_DIR: "/accounts/claude1"});
  expect(defaultAccountFolder(ctx, "claude")).toBe("/profile/claude");
  expect(defaultAccountFolder(ctx, "codex")).toBe(join(ctx.home, ".codex"));
  expect(withDefaultFolder(ctx, "claude-code", {})).toEqual({CLAUDE_CONFIG_DIR: "/profile/claude"});
  expect(claudeConfigFile(withDefaultFolder(ctx, "claude-code", {}), ctx.home)).toBe("/profile/claude/.claude.json");
  // When the profile stops setting it, the home default returns.
  recordDefaultFolder(ctx, "claude-code", {}, {});
  expect(defaultAccountFolder(ctx, "claude")).toBe(join(ctx.home, ".claude"));
});
