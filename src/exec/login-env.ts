import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";
import { execProcess, type ExecResult, type ExecSpec } from "./process";

/**
 * The environment a new terminal would give the user: the service's environment run through the user's
 * login shell, so PATH, locale, tool managers, proxies and keys exported by the profile apply to executors
 * the same way they do in a terminal. Values are held in memory only, never logged or written.
 */
export type Env = Record<string, string | undefined>;
export type TerminalEnv = {env: Env; source: "login-shell"; shell: string} | {env: Env; source: "service"; reason: string};

const MARKER = "__PACER_LOGIN_ENV__";
// A fixed command: no user or API text reaches the shell (SEC-5). `exec` skips logout scripts.
const COMMAND = `echo ${MARKER}; exec /usr/bin/env -0`;
export const LOGIN_ENV_TIMEOUT_MS = 5000;
const TTL_MS = 60_000;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// State of the shell that printed the environment, not of the user's profile.
const SHELL_STATE = new Set(["_", "PWD", "OLDPWD", "SHLVL"]);
/** pacer's own coordinates and capabilities: the service's values win, and profiles never see the tokens. */
const pacerOwned = (key: string) => key === "HOME" || key.startsWith("PACER_");

type Run = (spec: ExecSpec) => Promise<ExecResult>;
const cache = new Map<string, {at: number; result: Promise<TerminalEnv>}>();

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
  return {env: login, source: "login-shell", shell};
}

/**
 * Resolves the executor base environment once per service environment and caches it briefly. Falls back to the
 * service's environment, with a reason, when the login shell is unavailable, fails, or PACER_LOGIN_ENV=off.
 */
export async function terminalEnv(service: Env, options: {cwd: string; run?: Run; now?: number}): Promise<TerminalEnv> {
  if ((service.PACER_LOGIN_ENV ?? process.env.PACER_LOGIN_ENV) === "off") return {env: service, source: "service", reason: "disabled by PACER_LOGIN_ENV=off"};
  const shell = loginShell(service);
  if (!shell) return {env: service, source: "service", reason: "no login shell is configured"};
  const spawnEnv: Env = Object.fromEntries(Object.entries(service).filter(([key, value]) => value !== undefined && !key.startsWith("PACER_")));
  // Keyed by a digest, so the cache holds no copy of the service environment's values as keys.
  const key = createHash("sha256").update(JSON.stringify([shell, options.cwd, Object.entries(spawnEnv).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)])).digest("hex");
  const now = options.now ?? Date.now();
  for (const [stale, entry] of cache) if (now - entry.at >= TTL_MS) cache.delete(stale);
  let entry = cache.get(key);
  if (!entry) {
    const result = capture(shell, spawnEnv, options.cwd, options.run ?? execProcess)
      .catch(() => "the login shell could not be started")
      .then(found => typeof found === "string" ? {env: {}, source: "service" as const, reason: found} : found);
    // Failures are cached too, so a hanging profile costs one timeout per TTL rather than one per launch.
    entry = {at: now, result};
    cache.set(key, entry);
  }
  const found = await entry.result;
  return found.source === "login-shell" ? {...found, env: composeTerminalEnv(service, found.env)} : {env: service, source: "service", reason: found.reason};
}

/** For tests: forget cached login environments. */
export function clearTerminalEnvCache(): void { cache.clear(); }

/** One line for the attempt note when the login shell could not be used; null when it was, or was turned off. */
export function terminalEnvNote(found: TerminalEnv): string {
  return found.source === "service" && found.reason !== "disabled by PACER_LOGIN_ENV=off"
    ? `executor environment: login shell not used (${found.reason}); the agent runs with the pacer service's environment\n\n` : "";
}
