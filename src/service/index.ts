import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Ctx } from "../types";
import { readText } from "../install/fsx";
import { readManifest, writeManifest } from "../install/manifest";
import { pacerArgv } from "../install/self";
import { runInstall } from "../install/txn";
import { DEFAULT_PORT } from "../serve/http";

export const LABEL = "com.pacer.serve";
export const MARKER = "Managed by pacer service";
export interface ServiceStatus {
  installed: boolean; loaded: boolean; running: boolean; pid: number | null;
  lastExitCode: number | null; healthy: boolean; plistPath: string; binaryPath: string | null; binaryMatches: boolean;
}
export interface ServiceBackend {
  install(): Promise<string[]>; uninstall(): Promise<void>; status(timeoutMs?: number): Promise<ServiceStatus>;
  restart(): Promise<void>; logsPath(): string;
}
export interface ServiceDeps {
  platform?: string; uid?: number; argv?: string[]; port?: number;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>; waitMs?: number; healthTimeoutMs?: number;
}
export function servicePath(ctx: Ctx, platform: string): string {
  return platform === "darwin" ? join(ctx.home, "Library/LaunchAgents", `${LABEL}.plist`)
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
<key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key>${str("Background")}
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
StandardOutput=${quote(`append:${join(ctx.pacerHome, "logs/serve.log")}`)}
StandardError=${quote(`append:${join(ctx.pacerHome, "logs/serve.log")}`)}
[Install]
WantedBy=default.target
`;
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
export async function health(ctx: Ctx, deps: ServiceDeps = {}): Promise<boolean> {
  try {
    const r = await (deps.fetch ?? fetch)(`http://127.0.0.1:${deps.port ?? Number(ctx.env.PACER_PORT ?? DEFAULT_PORT)}/health`, { signal: AbortSignal.timeout(deps.healthTimeoutMs ?? 750) });
    return r.ok && r.headers.get("X-Pacer") === "1" && (await r.json() as { ok?: boolean }).ok === true;
  } catch { return false; }
}
export function serviceBackend(ctx: Ctx, deps: ServiceDeps = {}): ServiceBackend {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") throw new Error(`pacer service is not supported on ${platform}`);
  const mac = platform === "darwin", argv = deps.argv ?? pacerArgv(ctx.env);
  const path = servicePath(ctx, platform), target = `gui/${deps.uid ?? process.getuid?.() ?? 0}/${LABEL}`;
  const system = (cmd: string, ...args: string[]) => ["systemctl", "--user", cmd, ...args];
  async function run(args: string[], absent = false) {
    const r = await ctx.run(args, 10000);
    if (r.code !== 0 && !(absent && /not loaded|could not find service|no such process|not found|does not exist/i.test(r.stderr + r.stdout))) throw new Error(`${args.join(" ")}: ${r.stderr || r.stdout || `exit ${r.code}`}`);
  }
  const backend: ServiceBackend = {
    logsPath: () => join(ctx.pacerHome, "logs/serve.log"),
    async install() {
      const old = readText(path);
      let activated = false;
      try {
      const report = await runInstall({ ctx, pacerArgv: argv }, "service", async tx => {
        mkdirSync(join(ctx.pacerHome, "logs"), { recursive: true });
        tx.edit(path, () => mac ? plist(ctx, argv) : unit(ctx, argv), []);
        installedCache.delete(path);
        if (mac) { await run(["launchctl", "bootout", target], true); activated = true; await run(["launchctl", "bootstrap", target.slice(0, target.lastIndexOf("/")), path]); }
        else { await run(system("daemon-reload")); activated = true; await run(system("enable", "--now", "pacer-serve.service")); }
        const deadline = Date.now() + (deps.waitMs ?? 10000);
        do {
          const s = await backend.status(deps.waitMs === 0 ? 1000 : Math.max(1, deadline - Date.now()));
          if (s.running && s.healthy) return;
          if (Date.now() >= deadline) break;
          await Bun.sleep(Math.min(200, deadline - Date.now()));
        } while (Date.now() < deadline);
        throw new Error("service did not become running and healthy within 10 seconds; inspect pacer service logs");
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
    async restart() { await run(mac ? ["launchctl", "kickstart", "-k", target] : system("restart", "pacer-serve.service")); },
    async status(timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      const text = readText(path), binaryPath = text === null ? null : binaryInFile(text, platform);
      const r = await ctx.run(mac ? ["launchctl", "print", target] : system("show", "pacer-serve.service", "--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus"), timeoutMs);
      const parsed = mac ? { ...parseLaunchd(r.stdout), loaded: r.code === 0, running: r.code === 0 && (parseLaunchd(r.stdout).pid ?? 0) > 0 } : parseSystemd(r.stdout);
      return { ...parsed, loaded: r.code === 0 && parsed.loaded, running: r.code === 0 && parsed.running,
        installed: text !== null, healthy: r.code === 0 && parsed.running && Date.now() < deadline ? await health(ctx, { ...deps, healthTimeoutMs: Math.max(1, Math.min(750, deadline - Date.now())) }) : false,
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
  await serviceBackend(ctx, deps).restart(); return true;
}
