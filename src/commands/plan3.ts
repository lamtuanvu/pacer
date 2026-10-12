import { runGuard } from "../guard/guard";
import { runDoctor, renderDoctor } from "../install/doctor";
import { INSTALLERS, installPlanner, renderInstall, renderUninstall } from "../install";
import { initCmd } from "../install/init";
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
const isPlanner = (p: string | undefined): p is keyof typeof INSTALLERS =>
  p !== undefined && Object.hasOwn(INSTALLERS, p);
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
    usage: usage("install <planner>", "wire pacer into claude-code, codex, cursor or opencode"),
    async run(args, ctx) {
      const [planner] = args;
      if (!isPlanner(planner)) return badPlanner(planner);
      if (args.length !== 1) return error(2, "usage: pacer install <planner>");
      try {
        return ok(renderInstall(await installPlanner({ ctx, pacerArgv: pacerArgv(ctx.env) }, planner)));
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
        const report = await uninstallPlanner(ctx, planner);
        return report ? ok(renderUninstall(report)) : error(1, `pacer: ${planner} is not installed`);
      } catch (e) { return error(1, `pacer: ${message(e)}`); }
    },
  },
  {
    name: "init",
    usage: usage("init [--force] [--planner <p>]", "create a starter strategy from installed CLIs"),
    run(args, ctx) {
      let force = false;
      let planner: string | undefined;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--force") force = true;
        else if (args[i] === "--planner") {
          planner = args[++i];
          if (!isPlanner(planner)) return badPlanner(planner);
        } else return error(2, "usage: pacer init [--force] [--planner <p>]");
      }
      return initCmd(ctx, { force, planner });
    },
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
      try { return ok(await sessionStart(ctx, plannerFlag(args))); } catch { return ok(); }
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
