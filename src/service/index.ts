import { compiledNativeFixture, verifyNativeFixture } from "../update/desktop/native-fixture";
import { mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Ctx } from "../types";
import { readText } from "../install/fsx";
import { writeInstallFile } from "../install/atomic";
import { readManifest, writeManifest } from "../install/manifest";
import { isDevArgv, pacerArgv } from "../install/self";
import { runInstall } from "../install/txn";
import { DEFAULT_PORT } from "../serve/constants";
import { CoreError } from "../core/errors";

export const LABEL = "com.pacer.serve";
export const MARKER = "Managed by pacer service";
export interface ServiceStatus {
  installed: boolean; loaded: boolean; running: boolean; pid: number | null;
  healthPid?: number | null; warning?: string;
  lastExitCode: number | null; healthy: boolean; plistPath: string; binaryPath: string | null; binaryMatches: boolean;
}
export interface ServiceBackend {
  install(options?: { replace?: boolean }): Promise<string[]>; uninstall(): Promise<void>; status(timeoutMs?: number): Promise<ServiceStatus>;
  restart(): Promise<void>; logsPath(): string;
}
export interface ServiceDeps {
  platform?: string; uid?: number; argv?: string[]; port?: number;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>; waitMs?: number; healthTimeoutMs?: number;
  /** CLI upgrade-path calls to the restarted service (tests inject these). */
  upgrade?: import("./upgrade").UpgradeDeps;
}
/** Fixture labels are compile-time sandbox capabilities, never runtime environment choices. */
export function desktopServiceLabel(ctx: Ctx): string {
  const fixture=compiledNativeFixture();if(!fixture)return LABEL;
  verifyNativeFixture(fixture);
  if(realpathSync(ctx.home)!==fixture.home||realpathSync(ctx.pacerHome)!==fixture.home)throw Error("Native fixture home mismatch");
  return fixture.serviceLabel;
}
export function servicePath(ctx: Ctx, platform: string): string {
  const fixture=compiledNativeFixture();
  if(platform==="darwin"&&fixture)return join(fixture.root,"registrations",`${desktopServiceLabel(ctx)}.plist`);
  return platform === "darwin" ? join(ctx.home, "Library/LaunchAgents", `${desktopServiceLabel(ctx)}.plist`)
    : join(ctx.home, ".config/systemd/user/pacer-serve.service");
}
const installedCache = new Map<string, { at: number; installed: boolean }>();
/** Only file presence is needed by snapshots; never spawn a service manager in the publish loop. */
export function serviceInstalled(ctx: Ctx, platform: string = process.platform): boolean {
  if (platform !== "darwin" && platform !== "linux") return false;
  const path = servicePath(ctx, platform), cached = installedCache.get(path);
  if (cached && Date.now() - cached.at < 5000) return cached.installed;
  const installed = readText(path) !== null;
  installedCache.set(path, { at: Date.now(), installed }); return installed;
}
export function servicePATH(ctx: Ctx): string {
  const dirs = (ctx.env.PATH ?? process.env.PATH ?? "").split(":");
  for (const tool of ["orca", "codex", "claude", "cursor-agent", "opencode", "arkcli", "bun"]) {
    const path = ctx.which(tool); if (path) dirs.push(dirname(path));
  }
  return [...new Set(dirs.filter(Boolean))].join(":");
}
const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const unxml = (s: string) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
// systemd performs specifier expansion even inside quotes; ExecStart also expands $.
const quote = (s: string, exec = false) => '"' + s.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t").replaceAll("$", () => exec ? "$$" : "$") + '"';
// Standard, not Background: launchd throttles a Background job's disk I/O, and under
// memory pressure its reads stalled the service (and its health thread) for 30-90s.
export function plist(ctx: Ctx, argv: string[]): string {
  const str = (s: string) => `<string>${xml(s)}</string>`;
  const log = join(ctx.pacerHome, "logs/serve.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${MARKER} -->
<plist version="1.0"><dict>
<key>Label</key>${str(LABEL)}
<key>ProgramArguments</key><array>${[...argv, "serve"].map(str).join("")}</array>
<key>EnvironmentVariables</key><dict><key>HOME</key>${str(ctx.home)}<key>PATH</key>${str(servicePATH(ctx))}<key>PACER_HOME</key>${str(ctx.pacerHome)}${ctx.env.PACER_PORT ? `<key>PACER_PORT</key>${str(ctx.env.PACER_PORT)}` : ""}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key>${str("Standard")}
<key>StandardOutPath</key>${str(log)}<key>StandardErrorPath</key>${str(log)}
</dict></plist>
`;
}
export function unit(ctx: Ctx, argv: string[]): string {
  return `# ${MARKER}
[Unit]
Description=Pacer serve
[Service]
ExecStart=${[...argv, "serve"].map(s => quote(s, true)).join(" ")}
Environment=${quote(`HOME=${ctx.home}`)}
Environment=${quote(`PATH=${servicePATH(ctx)}`)}
Environment=${quote(`PACER_HOME=${ctx.pacerHome}`)}
${ctx.env.PACER_PORT ? `Environment=${quote(`PACER_PORT=${ctx.env.PACER_PORT}`)}\n` : ""}Restart=always
RestartSec=10
KillMode=process
StandardOutput=${quote(`append:${join(ctx.pacerHome, "logs/serve.log")}`)}
StandardError=${quote(`append:${join(ctx.pacerHome, "logs/serve.log")}`)}
[Install]
WantedBy=default.target
`;
}
/** Migrate only pacer-managed systemd units so a restart spares detached work. */
export function currentUnitText(text: string): string {
  if (!text.includes(MARKER) || /^KillMode=process$/m.test(text)) return text;
  const cleaned = text.replace(/^KillMode=.*\n/gm, "");
  if (/^RestartSec=10$/m.test(cleaned)) return cleaned.replace(/^RestartSec=10\n/m, "RestartSec=10\nKillMode=process\n");
  return cleaned.replace(/^\[Service\]\n/m, "[Service]\nKillMode=process\n");
}
export function binaryInFile(text: string, platform: string): string | null {
  if (platform === "darwin") {
    const a = text.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([\s\S]*?)<\/string>/);
    return a ? unxml(a[1]) : null;
  }
  const a = text.match(/^ExecStart="((?:\\.|[^"\\])*)"/m);
  if (a) return a[1].replace(/\\([\\"nrt])/g, (_, c: string) => ({ n: "\n", r: "\r", t: "\t" }[c] ?? c)).replaceAll("%%", "%").replaceAll("$$", "$");
  return text.match(/^ExecStart=([^\s]+)/m)?.[1] ?? null;
}
export function sameBinary(a: string | null, b: string): boolean {
  if (!a) return false;
  const canonical = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return canonical(a) === canonical(b);
}
export function parseLaunchd(text: string) {
  const n = (key: string) => { const m = text.match(new RegExp(`^\\s*${key} = (-?\\d+)\\s*$`, "m")); return m ? Number(m[1]) : null; };
  return { pid: n("pid"), lastExitCode: n("last exit code") };
}
export function parseSystemd(text: string) {
  const data = Object.fromEntries(text.split(/\r?\n/).map(l => { const at = l.indexOf("="); return [l.slice(0, at), l.slice(at + 1)]; }));
  return { loaded: data.LoadState === "loaded", running: data.ActiveState === "active" && data.SubState === "running",
    pid: Number(data.MainPID) > 0 ? Number(data.MainPID) : null,
    lastExitCode: /^-?\d+$/.test(data.ExecMainStatus ?? "") ? Number(data.ExecMainStatus) : null };
}
/** Match the desktop shell: only the job's own top-level environment owns it. */
function serviceOwner(text: string, mac: boolean, defaultHome: string) {
  const env = new Map<string, string>();
  if (mac) {
    let inside = false;
    for (const line of text.split(/\r?\n/)) {
      if (!inside) { inside = line === "\tenvironment = {"; continue; }
      if (line.trim() === "}") break;
      const entry = line.trim(), at = entry.indexOf(" => ");
      if (at !== -1) env.set(entry.slice(0, at), entry.slice(at + 4));
    }
  } else {
    const line = text.split(/\r?\n/).find(l => l.startsWith("Environment="))?.slice(12) ?? "";
    let word = "", quoted = false, escaped = false;
    const add = () => {
      const at = word.indexOf("=");
      if (at !== -1) env.set(word.slice(0, at), word.slice(at + 1));
      word = "";
    };
    for (const c of line) {
      if (escaped) { word += c; escaped = false; }
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = !quoted;
      else if (c === " " && !quoted) add();
      else word += c;
    }
    add();
  }
  const value = env.get("PACER_PORT") ?? "";
  const port = /^\+?\d+$/.test(value) && Number(value) <= 65535 ? Number(value) : DEFAULT_PORT;
  return { home: env.get("PACER_HOME") ?? defaultHome, port };
}
async function healthInfo(ctx: Ctx, deps: ServiceDeps = {}): Promise<{ok: boolean; pid: number | null}> {
  try {
    const r = await (deps.fetch ?? fetch)(`http://127.0.0.1:${deps.port ?? Number(ctx.env.PACER_PORT ?? DEFAULT_PORT)}/health`, { signal: AbortSignal.timeout(deps.healthTimeoutMs ?? 750) });
    if (!r.ok || r.headers.get("X-Pacer") !== "1") return {ok:false,pid:null};
    const body = await r.json() as {ok?: boolean; pid?: unknown};
    const pid = typeof body.pid === "number" && Number.isInteger(body.pid) && body.pid > 0 ? body.pid : null;
    return {ok:body.ok === true && pid !== null,pid};
  } catch { return {ok:false,pid:null}; }
}
export async function health(ctx: Ctx, deps: ServiceDeps = {}): Promise<boolean> {
  return (await healthInfo(ctx, deps)).ok;
}
/** Background services must not pin an ephemeral checkout unless explicitly overridden. */
function validateServiceArgv(ctx: Ctx, argv: string[]): void {
  if (ctx.env.PACER_BIN) return;
  const canonical = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const workspace = canonical(join(ctx.home, "orca/workspaces"));
  const transient = (arg: string) => {
    for (const path of new Set([resolve(arg), canonical(arg)])) {
      if (path === workspace || path.startsWith(workspace + "/") || /\/\.worktrees(?:\/|$)/.test(path)) return true;
      for (let dir = dirname(path);; dir = dirname(dir)) {
        try { if (statSync(join(dir, ".git")).isFile()) return true; } catch { /* No git metadata here. */ }
        if (dirname(dir) === dir) break;
      }
    }
    return false;
  };
  if (isDevArgv(argv) || argv.some(transient)) throw new Error("Refusing development service command; install a release binary or set PACER_BIN to a stable pacer executable.");
}
export function serviceBackend(ctx: Ctx, deps: ServiceDeps = {}): ServiceBackend {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") throw new Error(`pacer service is not supported on ${platform}`);
  const mac = platform === "darwin", argv = deps.argv ?? pacerArgv(ctx.env);
  const path = servicePath(ctx, platform), target = `gui/${deps.uid ?? process.getuid?.() ?? 0}/${LABEL}`;
  const system = (cmd: string, ...args: string[]) => ["systemctl", "--user", cmd, ...args];
  async function run(args: string[], absent = false) {
    let r = await ctx.run(args, 10000);
    if (r.code !== 0 && args[0] === "launchctl" && args[1] === "bootstrap" && /Input\/output error/i.test(r.stderr + r.stdout)) {
      await Bun.sleep(1000); r = await ctx.run(args, 10000);
    }
    if (r.code !== 0 && !(absent && /not loaded|could not find service|no such process|not found|does not exist/i.test(r.stderr + r.stdout))) throw new Error(`${args.join(" ")}: ${r.stderr || r.stdout || `exit ${r.code}`}`);
  }
  const backend: ServiceBackend = {
    logsPath: () => join(ctx.pacerHome, "logs/serve.log"),
    async install(options = {}) {
      validateServiceArgv(ctx, argv);
      const probe = await ctx.run(mac ? ["launchctl", "print", target] : system("show", "pacer-serve.service", "--property=Environment"), 10000);
      if (probe.code === 0) {
        const owner = serviceOwner(probe.stdout, mac, join(ctx.home, ".pacer"));
        const port = deps.port ?? Number(ctx.env.PACER_PORT ?? DEFAULT_PORT);
        if (!options.replace && (!sameBinary(owner.home, ctx.pacerHome) || owner.port !== port)) {
          throw new CoreError("conflict", `Another pacer (PACER_HOME ${owner.home}, port ${owner.port}) owns the login service. Stop it with "pacer service uninstall" from that pacer, or rerun with --replace.`);
        }
      } else if (!/not loaded|could not find (?:specified )?service|no such process|not found|does not exist/i.test(probe.stderr + probe.stdout)) {
        throw new CoreError("not_allowed", `Could not inspect the login service: ${probe.stderr || probe.stdout || `exit ${probe.code}`}`);
      }
      let old: string | null = null;
      let activated = false;
      try {
      const report = await runInstall({ ctx, pacerArgv: argv }, "service", async tx => {
        mkdirSync(join(ctx.pacerHome, "logs"), { recursive: true });
        const before = tx.read(path);
        old = before;
        tx.edit(path, () => mac ? plist(ctx, argv) : unit(ctx, argv), [], join(ctx.pacerHome, "backups/service"));
        installedCache.delete(path);
        // The manager must read the registration before the install transaction commits.
        // Stage it only while activating, then restore the pre-transaction state for commit.
        writeInstallFile(path, tx.read(path)!);
        try {
          if (mac) { await run(["launchctl", "bootout", target], true); activated = true; await run(["launchctl", "bootstrap", target.slice(0, target.lastIndexOf("/")), path]); }
          else { await run(system("daemon-reload")); activated = true; await run(system("enable", "--now", "pacer-serve.service")); }
          let verificationWarning: string | undefined;
          const deadline = Date.now() + (deps.waitMs ?? 10000);
          do {
            const s = await backend.status(deps.waitMs === 0 ? 1000 : Math.max(1, deadline - Date.now()));
            if (s.running && s.healthy) return;
            verificationWarning = s.warning;
            if (Date.now() >= deadline) break;
            await Bun.sleep(Math.min(200, deadline - Date.now()));
          } while (Date.now() < deadline);
          throw new Error(verificationWarning ?? "service did not become running and healthy within 10 seconds; inspect pacer service logs");
        } finally {
          if (before === null) rmSync(path, { force: true });
          else writeInstallFile(path, before);
        }
      });
      return report.notes;
      } catch (error) {
        installedCache.delete(path);
        if (activated) try {
          if (mac) {
            await run(["launchctl", "bootout", target], true);
            if (old !== null) await run(["launchctl", "bootstrap", target.slice(0, target.lastIndexOf("/")), path]);
          } else {
            if (old === null) await run(system("disable", "--now", "pacer-serve.service"), true);
            await run(system("daemon-reload"));
            if (old !== null) await run(system("restart", "pacer-serve.service"));
          }
        } catch (recovery) { throw new Error(`${(error as Error).message}; service recovery failed: ${(recovery as Error).message}`); }
        throw error;
      }
    },
    async uninstall() {
      const text = readText(path);
      if (text !== null && !(text.includes(MARKER) || (mac && /<key>Label<\/key>\s*<string>com\.pacer\.serve<\/string>/.test(text)))) throw new Error(`refusing to remove unrecognized service file ${path}`);
      if (mac) await run(["launchctl", "bootout", target], true);
      else if (text !== null) await run(system("disable", "--now", "pacer-serve.service"));
      rmSync(path, { force: true });
      installedCache.delete(path);
      if (!mac) await run(system("daemon-reload"));
      const m = readManifest(ctx); delete m.planners.service; writeManifest(ctx, m);
    },
    async restart() {
      if (mac) { await run(["launchctl", "kickstart", "-k", target]); return; }
      const text = readText(path);
      if (text !== null) {
        const next = currentUnitText(text);
        if (next !== text) { writeInstallFile(path, next); installedCache.delete(path); await run(system("daemon-reload")); }
      }
      await run(system("restart", "pacer-serve.service"));
    },
    async status(timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      const text = readText(path), binaryPath = text === null ? null : binaryInFile(text, platform);
      const r = await ctx.run(mac ? ["launchctl", "print", target] : system("show", "pacer-serve.service", "--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus"), timeoutMs);
      const parsed = mac ? { ...parseLaunchd(r.stdout), loaded: r.code === 0, running: r.code === 0 && (parseLaunchd(r.stdout).pid ?? 0) > 0 } : parseSystemd(r.stdout);
      const h = r.code === 0 && parsed.running && Date.now() < deadline ? await healthInfo(ctx, { ...deps, healthTimeoutMs: Math.max(1, Math.min(750, deadline - Date.now())) }) : {ok:false,pid:null};
      const warning = h.ok && h.pid !== parsed.pid ? `health pid mismatch: manager reports ${parsed.pid}, HTTP reports ${h.pid}` : undefined;
      return { ...parsed, healthPid:h.pid, ...(warning ? {warning} : {}), loaded: r.code === 0 && parsed.loaded, running: r.code === 0 && parsed.running,
        installed: text !== null, healthy: h.ok && h.pid === parsed.pid,
        plistPath: path, binaryPath, binaryMatches: sameBinary(binaryPath, argv[0]) };
    },
  };
  return backend;
}
export async function restartAfterUpdate(ctx: Ctx, binary: string, deps: ServiceDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return false;
  const text = readText(servicePath(ctx, platform));
  if (text === null || !sameBinary(binaryInFile(text, platform), binary)) return false;
  // A restart keeps the old launchd policy; reinstall a Background job so updates pick up Standard.
  if (platform === "darwin" && /<key>ProcessType<\/key>\s*<string>Background<\/string>/.test(text)) {
    await serviceBackend(ctx, deps).install(); return true;
  }
  await serviceBackend(ctx, deps).restart(); return true;
}

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };
/** Strict XML plist subset. Duplicate keys and unsupported values fail closed. */
export function parsePlistDictionary(text: string): { [key: string]: PlistValue } {
  if (text.length > 256 * 1024) throw new Error("plist exceeds inspection limit");
  let source = text.replace(/^\s*<\?xml[^?]*\?>/, "").replace(/<!--[^]*?-->/g, "");
  source = source.replace(/<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">/, "").trim();
  const wrapper = source.match(/^<plist(?:\s+version="1\.0")?>([^]*)<\/plist>$/);
  if (!wrapper) throw new Error("unsupported plist document");
  source = wrapper[1];
  let at = 0;
  const space = () => { while (/\s/.test(source[at] ?? "") && at < source.length) at++; };
  const take = (token: string) => { space(); if (!source.startsWith(token, at)) return false; at += token.length; return true; };
  const content = (tag: string): string => {
    if (!take(`<${tag}>`)) throw new Error(`expected plist ${tag}`);
    const end = source.indexOf(`</${tag}>`, at);
    if (end < 0) throw new Error("unterminated plist value");
    const raw = source.slice(at, end); at = end + tag.length + 3;
    if (raw.includes("<") || /&(?!(?:amp|lt|gt|quot|apos);)/.test(raw)) throw new Error("unsupported plist text");
    return unxml(raw);
  };
  const value = (depth: number): PlistValue => {
    if (depth > 16) throw new Error("plist nesting exceeds inspection limit");
    space();
    if (take("<dict>")) {
      const result: { [key: string]: PlistValue } = Object.create(null);
      while (!take("</dict>")) {
        const key = content("key");
        if (Object.hasOwn(result, key)) throw new Error("duplicate plist key");
        result[key] = value(depth + 1);
      }
      return result;
    }
    if (take("<array>")) {
      const result: PlistValue[] = [];
      while (!take("</array>")) result.push(value(depth + 1));
      return result;
    }
    if (take("<true/>")) return true;
    if (take("<false/>")) return false;
    if (take("<string/>")) return "";
    if (source.startsWith("<string>", at)) return content("string");
    if (source.startsWith("<integer>", at)) {
      const raw = content("integer"), number = Number(raw);
      if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(number)) throw new Error("invalid plist integer");
      return number;
    }
    throw new Error("unsupported plist value");
  };
  const result = value(0); space();
  if (at !== source.length || !result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid plist dictionary");
  return result;
}

export type DesktopServiceRegistration = { label: string; argv: string[]; home: string; pacerHome: string; port: number };
/** Static provenance only: loaded launchd state and running process identity need native verification. */
export function parseDesktopServiceRegistration(text: string, expectedLabel: string = LABEL): DesktopServiceRegistration {
  const data = parsePlistDictionary(text);
  const allowed = new Set(["Label", "ProgramArguments", "EnvironmentVariables", "RunAtLoad", "KeepAlive", "ThrottleInterval", "ProcessType", "StandardOutPath", "StandardErrorPath"]);
  if (Object.keys(data).some(key => !allowed.has(key))) throw new Error("unsupported service launch configuration");
  const argv = data.ProgramArguments, env = data.EnvironmentVariables;
  if (data.Label !== expectedLabel || !Array.isArray(argv) || !argv.every(arg => typeof arg === "string") ||
      !env || typeof env !== "object" || Array.isArray(env)) throw new Error("unrecognized service registration");
  if (Object.keys(env).some(key => !["HOME", "PATH", "PACER_HOME", "PACER_PORT"].includes(key)) ||
      typeof env.HOME !== "string" || typeof env.PACER_HOME !== "string") throw new Error("ambiguous service environment");
  if (argv[1] !== "serve" || !(argv.length === 2 || (argv.length === 4 && argv[2] === "--port"))) {
    throw new Error("unsupported or older service command; use a standalone CLI with verified admission support");
  }
  const configuredPort = env.PACER_PORT ?? String(DEFAULT_PORT);
  if (typeof configuredPort !== "string" || !/^\d+$/.test(configuredPort)) throw new Error("invalid service port");
  if (argv.length === 4 && argv[3] !== configuredPort) throw new Error("conflicting service ports");
  const port = Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid service port");
  return { label: expectedLabel, argv: argv as string[], home: env.HOME, pacerHome: env.PACER_HOME, port };
}
