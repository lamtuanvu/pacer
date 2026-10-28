import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { execProcess, type ExecResult, type ExecSpec } from "./process";

/**
 * The environment a new terminal would give the user: the service's environment run through the user's
 * login shell, so PATH, locale, tool managers, proxies and keys exported by the profile apply to executors
 * the same way they do in a terminal. Values are held in memory only, never logged or written.
 */
export type Env = Record<string, string | undefined>;
/** A per-folder tool's outcome for this run: which tool, and why it was skipped; never a value. */
export type FolderTool = {tool: "direnv" | "mise"; status: "applied"; withheld?: string[]} | {tool: "direnv" | "mise"; status: "skipped"; reason: string};
export type TerminalEnv = {
  env: Env; source: "login-shell"; shell: string;
  /** The login shell's umask (validated octal), or why the service's umask stays. */
  umask: {mask: string} | {reason: string};
  /** Which of PROFILE_KEYS the profile or a per-folder tool set, as opposed to the service. */
  profileKeys: string[];
  folder: FolderTool[];
} | {env: Env; source: "service"; reason: string};

const MARKER = "__PACER_LOGIN_ENV__";
const UMASK_MARKER = "__PACER_LOGIN_UMASK__";
// A fixed command: no user or API text reaches the shell (SEC-5). `exec` skips logout scripts.
const COMMAND = `echo ${UMASK_MARKER}; umask; echo ${MARKER}; exec /usr/bin/env -0`;
/**
 * Variables whose origin matters: pacer removes the service's values (automation color flags, the service's own
 * account folder) but keeps what the user's profile sets. They are withheld from the login shell's environment so
 * that their presence in its output means the profile set them.
 */
export const PROFILE_KEYS = ["NO_COLOR", "FORCE_COLOR", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;
/** Account folder variables: only the login profile or the strategy selects them, never a repository's .envrc or mise config. */
const ACCOUNT_KEYS = new Set(["CLAUDE_CONFIG_DIR", "CODEX_HOME"]);
/** Strict delegation enforcement certified the service's environment; the attempt runs with exactly that. */
export const STRICT_SERVICE_ENV = "strict delegation enforcement runs with the certified service environment";
export const FOLDER_TOOL_TIMEOUT_MS = 5000;
const OCTAL_UMASK = /^[0-7]{3,4}$/;
export const LOGIN_ENV_TIMEOUT_MS = 5000;
const TTL_MS = 60_000;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// State of the shell that printed the environment, not of the user's profile.
const SHELL_STATE = new Set(["_", "PWD", "OLDPWD", "SHLVL"]);
/** pacer's own coordinates and capabilities: the service's values win, and profiles never see the tokens. */
const pacerOwned = (key: string) => key === "HOME" || key.startsWith("PACER_");

type Run = (spec: ExecSpec) => Promise<ExecResult>;
const cache = new Map<string, {at: number; result: Promise<TerminalEnv>}>();
/** The last login PATH per cache key, kept past the TTL so status can read it without waiting on a shell. */
const knownPaths = new Map<string, string>();

/** The user's login shell: $SHELL when it is an absolute, existing path, else the account's shell. */
export function loginShell(env: Env): string | null {
  for (const candidate of [env.SHELL, (() => { try { return userInfo().shell ?? undefined; } catch { return undefined; } })()]) {
    if (candidate && isAbsolute(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Parses `env -0` output after the marker; profile output before it is ignored. */
export function parseLoginEnv(stdout: string): Env | null {
  const at = stdout.indexOf(`${MARKER}\n`);
  if (at < 0) return null;
  const env: Env = {};
  for (const entry of stdout.slice(at + MARKER.length + 1).split("\0")) {
    const eq = entry.indexOf("=");
    const key = entry.slice(0, eq);
    if (eq > 0 && NAME.test(key) && !SHELL_STATE.has(key)) env[key] = entry.slice(eq + 1);
  }
  return Object.keys(env).length ? env : null;
}

/** The umask the login shell printed before the environment; null unless it is a strict 3-4 digit octal. */
export function parseLoginUmask(stdout: string): string | null {
  const start = stdout.indexOf(`${UMASK_MARKER}\n`), end = stdout.indexOf(`${MARKER}\n`);
  if (start < 0 || end < start) return null;
  const mask = stdout.slice(start + UMASK_MARKER.length + 1, end).trim();
  return OCTAL_UMASK.test(mask) ? mask : null;
}

/**
 * Runs argv under the given umask through a fixed /bin/sh wrapper; the mask is validated octal and passed as an
 * argument, never as shell text (SEC-5). Only the child gets the mask; the service's own umask is unchanged.
 */
export function withUmask(argv: string[], mask?: string): string[] {
  if (!mask || !OCTAL_UMASK.test(mask)) return argv;
  return ["/bin/sh", "-c", 'umask "$1" && shift && exec "$@"', "pacer-umask", mask, ...argv];
}

/** Login-shell variables over the service's, then pacer's own on top. Nothing pacer does not own is removed. */
export function composeTerminalEnv(service: Env, login: Env): Env {
  const env: Env = {...service};
  for (const [key, value] of Object.entries(login)) if (!pacerOwned(key)) env[key] = value;
  for (const [key, value] of Object.entries(service)) if (pacerOwned(key)) env[key] = value;
  return env;
}

async function capture(shell: string, spawnEnv: Env, cwd: string, run: Run): Promise<TerminalEnv | string> {
  // stdin is /dev/null, so a profile that prompts reads end-of-file instead of waiting.
  const result = await run({argv: [shell, "-l", "-i", "-c", COMMAND], cwd, env: spawnEnv, timeoutMs: LOGIN_ENV_TIMEOUT_MS, maxStdoutBytes: 4 * 1024 * 1024});
  if (result.timedOut) return `the login shell did not finish within ${LOGIN_ENV_TIMEOUT_MS / 1000}s`;
  if (result.stdoutOverflow) return "the login shell printed too much output";
  const login = parseLoginEnv(result.stdout);
  if (!login) return result.code === 0 ? "the login shell printed no environment" : `the login shell exited ${result.code}`;
  const mask = parseLoginUmask(result.stdout);
  return {env: login, source: "login-shell", shell, umask: mask ? {mask} : {reason: "the login shell printed no valid umask"}, profileKeys: [], folder: []};
}

/** An executable named `name` on the environment's PATH, as an absolute path. */
export function onPath(env: Env, name: string): string | null {
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir || !isAbsolute(dir)) continue;
    const file = join(dir, name);
    try { if (statSync(file).isFile()) { accessSync(file, constants.X_OK); return file; } } catch { /* next entry */ }
  }
  return null;
}

/** True when the directory or one of its parents has an .envrc, as direnv looks for one. */
function hasEnvrc(dir: string): boolean {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, ".envrc"))) return true;
    if (dirname(at) === at) return false;
  }
}

/** Parses a tool's JSON export: names to strings, or null (unset) where `unsets` is allowed. */
function parseExport(stdout: string, unsets: boolean): Record<string, string | null> | null {
  if (!stdout.trim()) return {};
  let data: unknown;
  try { data = JSON.parse(stdout); } catch { return null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!NAME.test(key)) return null;
    if (typeof value === "string" || (unsets && value === null)) out[key] = value;
    else return null;
  }
  return out;
}

async function folderTool(tool: "direnv" | "mise", binary: string, env: Env, cwd: string, run: Run): Promise<FolderTool & {changes?: Record<string, string | null>}> {
  // Fixed argv (SEC-5). Never `direnv allow` or `mise trust`: each tool's own trust decides.
  const argv = tool === "direnv" ? [binary, "export", "json"] : [binary, "env", "--json"];
  const spawnEnv = Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !key.startsWith("PACER_")));
  let result: ExecResult;
  try { result = await run({argv, cwd, env: spawnEnv, timeoutMs: FOLDER_TOOL_TIMEOUT_MS, maxStdoutBytes: 4 * 1024 * 1024}); }
  catch { return {tool, status: "skipped", reason: "could not be started"}; }
  if (result.timedOut) return {tool, status: "skipped", reason: `did not finish within ${FOLDER_TOOL_TIMEOUT_MS / 1000}s`};
  if (result.stdoutOverflow) return {tool, status: "skipped", reason: "printed too much output"};
  // Only the tool's own trust verdict is recognised; its message is never copied (it may quote values).
  if (tool === "direnv" && /is blocked|not allowed/i.test(result.stderr)) return {tool, status: "skipped", reason: ".envrc is not allowed (direnv allow decides)"};
  if (tool === "mise" && /not trusted/i.test(result.stderr)) return {tool, status: "skipped", reason: "the folder's config is not trusted (mise trust decides)"};
  if (result.code !== 0) return {tool, status: "skipped", reason: `exited ${result.code}`};
  const changes = parseExport(result.stdout, tool === "direnv");
  if (!changes) return {tool, status: "skipped", reason: "printed output that is not an environment"};
  return {tool, status: "applied", changes};
}

/**
 * What a terminal's `cd` into the folder adds: direnv, then mise, each only when on the login PATH and as each
 * tool's own trust allows. Applied changes include direnv's unsets; pacer-owned variables are never changed.
 */
export async function applyFolderTools(env: Env, cwd: string, run: Run = execProcess): Promise<{env: Env; folder: FolderTool[]; changed: string[]}> {
  const out: Env = {...env}, folder: FolderTool[] = [], changed: string[] = [];
  for (const tool of ["direnv", "mise"] as const) {
    const binary = onPath(out, tool);
    if (!binary || (tool === "direnv" && !hasEnvrc(cwd))) continue;
    const {changes, ...outcome} = await folderTool(tool, binary, out, cwd, run);
    folder.push(outcome);
    const withheld: string[] = [];
    for (const [key, value] of Object.entries(changes ?? {})) {
      if (pacerOwned(key)) continue;
      if (ACCOUNT_KEYS.has(key)) { withheld.push(key); continue; }
      if (value === null) delete out[key]; else out[key] = value;
      changed.push(key);
    }
    if (withheld.length && outcome.status === "applied") folder[folder.length - 1] = {...outcome, withheld};
  }
  return {env: out, folder, changed};
}

/**
 * Resolves the executor base environment once per service environment and caches it briefly. Falls back to the
 * service's environment, with a reason, when the login shell is unavailable, fails, or PACER_LOGIN_ENV=off.
 */
const loginDisabled = (service: Env) => (service.PACER_LOGIN_ENV ?? process.env.PACER_LOGIN_ENV) === "off";
const spawnEnvOf = (service: Env): Env => Object.fromEntries(Object.entries(service).filter(([key, value]) => value !== undefined && !key.startsWith("PACER_") && !(PROFILE_KEYS as readonly string[]).includes(key)));
// Keyed by a digest, so the cache holds no copy of the service environment's values as keys.
const cacheKey = (shell: string, cwd: string, spawnEnv: Env) => createHash("sha256").update(JSON.stringify([shell, cwd, Object.entries(spawnEnv).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)])).digest("hex");

export async function terminalEnv(service: Env, options: {cwd: string; workdir?: string; run?: Run; now?: number}): Promise<TerminalEnv> {
  if (loginDisabled(service)) return {env: service, source: "service", reason: "disabled by PACER_LOGIN_ENV=off"};
  const shell = loginShell(service);
  if (!shell) return {env: service, source: "service", reason: "no login shell is configured"};
  const spawnEnv = spawnEnvOf(service);
  const key = cacheKey(shell, options.cwd, spawnEnv);
  const now = options.now ?? Date.now();
  for (const [stale, entry] of cache) if (now - entry.at >= TTL_MS) cache.delete(stale);
  let entry = cache.get(key);
  if (!entry) {
    const result = capture(shell, spawnEnv, options.cwd, options.run ?? execProcess)
      .catch(() => "the login shell could not be started")
      .then(found => typeof found === "string" ? {env: {}, source: "service" as const, reason: found} : found)
      .then(found => {
        if (found.source === "login-shell") knownPaths.set(key, composeTerminalEnv(service, found.env).PATH ?? "");
        else knownPaths.delete(key);
        return found;
      });
    // Failures are cached too, so a hanging profile costs one timeout per TTL rather than one per launch.
    entry = {at: now, result};
    cache.set(key, entry);
  }
  const found = await entry.result;
  if (found.source !== "login-shell") return {env: service, source: "service", reason: found.reason};
  const composed = composeTerminalEnv(service, found.env);
  // Per-folder state is read for every launch and never cached: it belongs to the workdir, not the profile.
  const folder = options.workdir ? await applyFolderTools(composed, options.workdir, options.run ?? execProcess) : {env: composed, folder: [], changed: []};
  const profileKeys = PROFILE_KEYS.filter(key => (found.env[key] !== undefined || folder.changed.includes(key)) && folder.env[key] !== undefined);
  return {...found, env: folder.env, profileKeys, folder: folder.folder};
}

/**
 * The PATH an executor launched now would get, without waiting on a shell: the last login PATH read for this
 * service environment (kept past the cache's TTL), or undefined when none has been read yet, in which case the
 * caller uses the service's PATH. The service and the task runner read the login environment ahead of routing.
 */
export function cachedLoginPath(service: Env, cwd: string): string | undefined {
  if (loginDisabled(service)) return undefined;
  const shell = loginShell(service);
  return shell ? knownPaths.get(cacheKey(shell, cwd, spawnEnvOf(service))) || undefined : undefined;
}

/** Strict work's base environment: the service's own, with the reason the login shell was not used. */
export const strictServiceEnv = (service: Env): TerminalEnv => ({env: service, source: "service", reason: STRICT_SERVICE_ENV});

/** For tests: forget cached login environments. */
export function clearTerminalEnvCache(): void { cache.clear(); knownPaths.clear(); }

/** Lines for the attempt note: why the login shell, its umask or a per-folder tool was not used. Never values. */
export function terminalEnvNote(found: TerminalEnv): string {
  if (found.source === "service") return found.reason !== "disabled by PACER_LOGIN_ENV=off"
    ? `executor environment: login shell not used (${found.reason}); the agent runs with the pacer service's environment\n\n` : "";
  const lines = [
    ...("reason" in found.umask ? [`executor environment: login umask not applied (${found.umask.reason}); the agent runs with the pacer service's umask`] : []),
    ...found.folder.flatMap(tool => tool.status === "skipped" ? [`executor environment: ${tool.tool} not applied (${tool.reason})`]
      : tool.withheld?.length ? [`executor environment: ${tool.tool}'s ${tool.withheld.join(", ")} not applied (account folders come from the login profile or the strategy)`] : []),
  ];
  return lines.length ? lines.join("\n") + "\n\n" : "";
}

/** The environment.json record: where the base environment came from and what applied; names and reasons only. */
export function terminalEnvRecord(found: TerminalEnv): Record<string, unknown> {
  return found.source === "login-shell"
    ? {source: found.source, shell: found.shell, umask: "mask" in found.umask ? "login" : {service: found.umask.reason}, profileKeys: found.profileKeys, folder: found.folder}
    : {source: found.source, reason: found.reason};
}

/** The umask the executor should run under: the login shell's, or undefined to keep the service's. */
export const terminalUmask = (found: TerminalEnv): string | undefined => found.source === "login-shell" && "mask" in found.umask ? found.umask.mask : undefined;
/** The profile-set color flags an interactive session keeps. */
export const profileColor = (found: TerminalEnv): string[] => found.source === "login-shell" ? found.profileKeys.filter(key => key === "NO_COLOR" || key === "FORCE_COLOR") : [];
/** The profile-set keys the executor environment keeps (the account folder variables among them). */
export const profileKeys = (found: TerminalEnv | undefined): string[] => found?.source === "login-shell" ? found.profileKeys : [];
