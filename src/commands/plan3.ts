import { parseRunnerId } from "../config/runner-id";
import { runGuard } from "../guard/guard";
import { runDoctor, renderDoctor } from "../install/doctor";
import { INSTALLERS, installPlanner, renderInstall, renderUninstall } from "../install";
import { setupCmd, INIT_USAGE } from "./setup";
import { pacerArgv } from "../install/self";
import { sessionStart } from "../install/session";
import { statusLine } from "../install/statusline";
import { io } from "../install/stdin";
import { InstallError } from "../install/txn";
import { uninstallPlanner } from "../install/uninstall";
import { rebuildActivity } from "../pace/activity";
import type { Command, Result } from "./types";

const ok = (out = ""): Result => ({ code: 0, out, err: "" });
const error = (code: number, err: string): Result => ({ code, out: "", err });
const message = (e: unknown): string => e instanceof Error ? e.message : String(e);
const usage = (text: string, description: string): string => text.padEnd(47) + description;
const isPlanner = (p: string | undefined): p is string => {
  const id = p ? parseRunnerId(p) : null;
  return !!id && !id.host && Object.hasOwn(INSTALLERS, id.agent);
};
const installTarget = (p: string) => {
  const id = parseRunnerId(p)!;
  return id.account ? {agent: id.agent, account: id.account} : id.agent as keyof typeof INSTALLERS;
};
const plannerFlag = (args: string[]): string => {
  const index = args.indexOf("--planner");
  return index < 0 ? "" : args[index + 1] ?? "";
};
const badPlanner = (p: string | undefined): Result => error(2,
  `pacer: unknown planner ${p ?? "(missing)"}; choose ${Object.keys(INSTALLERS).join(", ")}`);

/** CLI commands added by Plan 3. Only Plan 3 edits this file. */
export const COMMANDS: Command[] = [
  {
    name: "install",
    usage: usage("install <planner> [--mcp|--no-mcp]", "wire pacer into claude-code, codex, cursor or opencode"),
    async run(args, ctx) {
      const [planner] = args;
      if (!isPlanner(planner)) return badPlanner(planner);
      if (args.slice(1).some(a=>!["--mcp","--no-mcp"].includes(a)) || args.includes("--mcp")&&args.includes("--no-mcp")) return error(2, "usage: pacer install <planner> [--mcp|--no-mcp]");
      try {
        return ok(renderInstall(await installPlanner({ ctx, pacerArgv: pacerArgv(ctx.env), ...(args.includes("--mcp")?{mcp:true}:args.includes("--no-mcp")?{mcp:false}:{}) }, installTarget(planner))));
      } catch (e) {
        if (e instanceof InstallError) return error(1, `pacer: ${e.message}`);
        return error(1, `pacer: ${message(e)}`);
      }
    },
  },
  {
    name: "uninstall",
    usage: usage("uninstall <planner>", "undo pacer install (restores backups)"),
    async run(args, ctx) {
      const [planner] = args;
      if (!isPlanner(planner)) return badPlanner(planner);
      if (args.length !== 1) return error(2, "usage: pacer uninstall <planner>");
      try {
        const report = await uninstallPlanner(ctx, installTarget(planner));
        return report ? ok(renderUninstall(report)) : error(1, `pacer: ${planner} is not installed`);
      } catch (e) { return error(1, `pacer: ${message(e)}`); }
    },
  },
  {
    name: "init",
    usage: usage(INIT_USAGE, "set up strategy, service, agents and Orca live panel"),
    run: setupCmd,
  },
  {
    name: "doctor",
    usage: usage("doctor [--json]", "check strategy, CLIs, usage and installed integrations"),
    async run(args, ctx) {
      if (args.length && (args.length !== 1 || args[0] !== "--json")) return error(2, "usage: pacer doctor [--json]");
      try {
        const checks = await runDoctor(ctx);
        return { code: checks.some(check => check.level === "fail") ? 1 : 0,
          out: args.length ? JSON.stringify(checks, null, 2) : renderDoctor(checks), err: "" };
      } catch (e) { return error(1, `pacer: ${message(e)}`); }
    },
  },
  {
    name: "guard",
    usage: usage("guard --planner <p>", "guard planner subagent execution"),
    async run(args, ctx) {
      const planner = plannerFlag(args);
      try { return ok(await runGuard(ctx, planner, await io.readStdin())); }
      catch { return ok(await runGuard(ctx, planner, "")); }
    },
  },
  {
    name: "statusline",
    usage: usage("statusline", "capture Claude rate limits and print budget status"),
    async run(_args, ctx) {
      let stdin = "";
      try { stdin = await io.readStdin(); } catch { /* Hooks fail open on stdin errors. */ }
      try { return ok(await statusLine(ctx, stdin)); } catch { return ok(); }
    },
  },
  {
    name: "session-start",
    usage: usage("session-start --planner <p>", "print planner policy and budget context"),
    async run(args, ctx) {
      try { return ok(await sessionStart(ctx, plannerFlag(args), {}, await io.readStdin().catch(() => ""))); } catch { return ok(); }
    },
  },
  {
    name: "_activity",
    usage: usage("_activity", "rebuild the activity profile (internal)"),
    async run(_args, ctx) {
      try { await rebuildActivity(ctx); return ok(); }
      catch (e) { return error(1, `pacer: ${message(e)}`); }
    },
  },
];
