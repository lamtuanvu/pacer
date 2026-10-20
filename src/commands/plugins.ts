import { createInterface } from "node:readline";
import { callOp } from "../api/ops";
import { CoreError } from "../core/errors";
import { pluginCli } from "../plugin/cli";
import { shutdownPlugins } from "../plugins";
import { runBundledPlugin } from "../plugins/run";
import type { Ctx } from "../types";
import { commandArgs } from "./accounts";
import type { Command, Result } from "./types";

const USAGE = "usage: pacer plugin list [--json] | enable <id> [--yes] | disable <id> | remove <id> | doctor [<id>] [--json]\n       pacer plugin uninstall   (removes the Orca plugin an earlier pacer installed)";
/** Orca plugin verbs retired in 0.5.0: `uninstall` still cleans up an old install; the others explain the retirement. */
const ORCA_VERBS = ["uninstall", "install", "status", "set"];
const fail = (code: number, e: unknown): Result => ({ code, out: "", err: `pacer: ${e instanceof Error ? e.message : String(e)}` });

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await new Promise<string>(r => rl.question(`${question} [y/N] `, r))).trim()); } finally { rl.close(); }
}

interface Info { id: string; version: string; state: string; tier: string; bundled: boolean; contributes: string[]; error: string | null }
interface Report { id: string; ok: boolean; state: string; served: string[]; protocol: { host: string; plugin: string | null }; restarts: number; error: string | null; needs: string | null }

export async function pluginsCmd(args: string[], ctx: Ctx): Promise<Result> {
  const [verb, ...rest] = args;
  if (verb !== undefined && ORCA_VERBS.includes(verb)) return pluginCli(args, ctx);
  try {
    if (verb === "run") {
      if (rest.length !== 1) return { code: 2, out: "", err: "usage: pacer plugin run <id>" };
      const code = await runBundledPlugin(rest[0]);
      return { code, out: "", err: code === 0 ? "" : `pacer: no bundled plugin ${rest[0]}`, keepAlive: code === 0 };
    }
    const { pos, flags } = commandArgs(rest, [], ["json", "yes"]);
    switch (verb) {
      case "list": {
        const { plugins } = await callOp(ctx, "plugin.list", {}) as { plugins: Info[] };
        if (flags.json) return { code: 0, out: JSON.stringify({ plugins }, null, 2), err: "" };
        const lines = plugins.map(p => `${p.id.padEnd(24)} ${p.version.padEnd(10)} ${p.state.padEnd(12)} ${p.tier.padEnd(10)} ${p.bundled ? "bundled" : "installed"}${p.contributes.length ? `  ${p.contributes.join(", ")}` : ""}${p.error ? `\n  ${p.error}` : ""}`);
        return { code: 0, out: lines.join("\n") || "no plugins", err: "" };
      }
      case "enable": {
        if (pos.length !== 1) throw Error(USAGE);
        let r = await callOp(ctx, "plugin.enable", { id: pos[0] }) as { id: string; state: string; needs?: string[] };
        if (r.state === "needs_grant" && r.needs) {
          const ask = `${pos[0]} asks for: ${r.needs.join(", ") || "no capabilities"}. Grant and enable?`;
          if (!flags.yes && !(await confirm(ask))) return { code: 1, out: "", err: `pacer: ${pos[0]} not enabled. ${ask} Re-run with --yes to grant.` };
          r = await callOp(ctx, "plugin.enable", { id: pos[0], grant: true }) as typeof r;
        }
        return { code: 0, out: `${r.id}: ${r.state}`, err: "" };
      }
      case "disable": {
        if (pos.length !== 1) throw Error(USAGE);
        const r = await callOp(ctx, "plugin.disable", { id: pos[0] }) as { id: string; state: string };
        return { code: 0, out: `${r.id}: ${r.state}`, err: "" };
      }
      case "remove": {
        if (pos.length !== 1) throw Error(USAGE);
        await callOp(ctx, "plugin.remove", { id: pos[0] });
        return { code: 0, out: `removed ${pos[0]}`, err: "" };
      }
      case "doctor": {
        const { reports } = await callOp(ctx, "plugin.doctor", pos[0] ? { id: pos[0] } : {}) as { reports: Report[] };
        if (flags.json) return { code: 0, out: JSON.stringify({ reports }, null, 2), err: "" };
        const lines = reports.map(r => `${r.id.padEnd(24)} ${r.ok ? "ok" : "FAIL"}  ${r.state}  protocol ${r.protocol.plugin ?? "?"} (host ${r.protocol.host})  serves ${r.served.join(", ") || "-"}  restarts ${r.restarts}${r.error ? `\n  ${r.error}${r.needs && !r.ok ? ` (needs host ${r.needs})` : ""}` : ""}`);
        return { code: reports.every(r => r.ok) ? 0 : 1, out: lines.join("\n") || "no plugins", err: "" };
      }
      default: return { code: 2, out: "", err: USAGE };
    }
  } catch (e) {
    return fail(e instanceof CoreError ? 1 : 2, e);
  } finally {
    await shutdownPlugins(ctx);
  }
}

const usage = (cmd: string, desc: string): string => `${cmd.padEnd(47)}${desc}`;
export const COMMANDS: Command[] = [
  { name: "plugin", usage: usage("plugin list|enable|disable|remove|doctor", "manage plugins (uninstall: remove the old Orca plugin)"), run: pluginsCmd },
];
