import { restartConsoles } from "../console/restart";
import type { Ctx } from "../types";
import type { Result } from "../commands/types";
import { readText } from "../install/fsx";
import { serviceBackend, type ServiceDeps } from "./index";
export const SERVICE_USAGE = "service install|uninstall|status [--json]|restart|logs [-n N]";
export async function serviceCli(args: string[], ctx: Ctx, deps: ServiceDeps = {}): Promise<Result> {
  const [cmd, ...rest] = args;
  const bad = () => ({ code: 2, out: "", err: `usage: pacer ${SERVICE_USAGE}` });
  if (!["install", "uninstall", "status", "restart", "logs"].includes(cmd)) return bad();
  if (cmd === "status" ? rest.length > 1 || rest.some(x => x !== "--json") : cmd === "logs" ? rest.length !== 0 && (rest.length !== 2 || rest[0] !== "-n" || !/^\d+$/.test(rest[1]) || !Number.isSafeInteger(Number(rest[1]))) : rest.length > 0) return bad();
  try {
    const b = serviceBackend(ctx, deps); let out: string;
    switch (cmd) {
      case "install": out = ["installed pacer serve", ...await b.install()].join("\n"); break;
      case "uninstall": await b.uninstall(); out = "uninstalled pacer serve"; break;
      case "restart": await b.restart(); out = `restarted pacer serve\nrestarted ${await restartConsoles(ctx)} pacer consoles`; break;
      case "status": {
        const s = await b.status();
        out = rest.length ? JSON.stringify(s, null, 2) : `installed: ${s.installed}; loaded: ${s.loaded}; running: ${s.running}; healthy: ${s.healthy}\npid: ${s.pid ?? "-"}; last exit code: ${s.lastExitCode ?? "-"}\nservice: ${s.plistPath}\nbinary: ${s.binaryPath ?? "-"}; matches current: ${s.binaryMatches}`; break;
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
