import type { Ctx } from "../types";
import type { Result } from "../commands/types";
import { readText } from "../install/fsx";
import { isExecutorSession } from "../install/role";
import { serviceBackend, type ServiceDeps } from "./index";
import { restartAroundWork, UPGRADE_CLI_REFUSAL } from "./upgrade";
export const SERVICE_USAGE = "service install [--replace]|uninstall|status [--json]|restart|logs [-n N]";
export async function serviceCli(args: string[], ctx: Ctx, deps: ServiceDeps = {}): Promise<Result> {
  const [cmd, ...rest] = args;
  const bad = () => ({ code: 2, out: "", err: `usage: pacer ${SERVICE_USAGE}` });
  if (!["install", "uninstall", "status", "restart", "logs"].includes(cmd)) return bad();
  if (cmd === "install" ? rest.length > 1 || rest.some(x => x !== "--replace") : cmd === "status" ? rest.length > 1 || rest.some(x => x !== "--json") : cmd === "logs" ? rest.length !== 0 && (rest.length !== 2 || rest[0] !== "-n" || !/^\d+$/.test(rest[1]) || !Number.isSafeInteger(Number(rest[1]))) : rest.length > 0) return bad();
  // A guard against accidental self-upgrade from a delegated task, not an authorization boundary.
  if (["install", "restart", "uninstall"].includes(cmd) && isExecutorSession(ctx)) return { code: 2, out: "", err: `pacer service: ${UPGRADE_CLI_REFUSAL}` };
  try {
    const b = serviceBackend(ctx, deps); let out: string;
    const report = (r: { summary: string | null; warning?: string }) => [...(r.summary ? [r.summary] : []), ...(r.warning ? [`WARNING: ${r.warning}`] : [])];
    switch (cmd) {
      case "install": {
        const notes: string[] = [];
        const r = await restartAroundWork(ctx, async () => { notes.push(...await b.install({ replace: rest.includes("--replace") })); return true; }, { prefix: v => `Restarted on v${v}.`, deps: deps.upgrade });
        out = ["installed pacer serve", ...notes, ...report(r)].join("\n"); break;
      }
      case "uninstall": await b.uninstall(); out = "uninstalled pacer serve"; break;
      case "restart": {
        const r = await restartAroundWork(ctx, async () => { await b.restart(); return true; }, { prefix: v => `Restarted on v${v}.`, deps: deps.upgrade });
        out = ["restarted pacer serve", ...report(r)].join("\n"); break;
      }
      case "status": {
        const s = await b.status();
        out = rest.length ? JSON.stringify(s, null, 2) : `installed: ${s.installed}; loaded: ${s.loaded}; running: ${s.running}; healthy: ${s.healthy}\npid: ${s.pid ?? "-"}; last exit code: ${s.lastExitCode ?? "-"}\nservice: ${s.plistPath}\nbinary: ${s.binaryPath ?? "-"}; matches current: ${s.binaryMatches}${s.warning ? `\nWARNING: ${s.warning}` : ""}`; break;
      }
      default: {
        const text = readText(b.logsPath()); if (text === null) throw new Error(`no log at ${b.logsPath()}`);
        const n = rest.length ? Number(rest[1]) : 50;
        const lines = text.replace(/\n$/, "").split("\n"); out = n === 0 ? "" : lines.slice(-n).join("\n");
      }
    }
    return { code: 0, out, err: "" };
  } catch (e) { return { code: 1, out: "", err: `pacer service: ${(e as Error).message}` }; }
}
