import { accessSync, chmodSync, constants, existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Ctx } from "../types";
import type { Result } from "../commands/types";
import { PLUGIN_RECORD } from "../link/paths";
import { pidAlive } from "../link/store";
import { listTasks } from "../tasks/store";
import type { TaskState } from "../tasks/types";
import { pluginDir, uninstallPlugin } from "../plugin/install";
import { serviceBackend, servicePath, type ServiceBackend } from "../service";
import { readManifest } from "./manifest";
import { appLink, removePathBlock } from "./path-block";
import { pacerArgv } from "./self";
import { uninstallPlanner, type UninstallReport } from "./uninstall";

export const UNINSTALL_ALL_USAGE = "uninstall --all [--yes] [--binary] [--force] [--json]";
interface BlockingTask {
  id: string;
  state: TaskState;
  goal: string;
  runner_pid?: number;
  runner_alive?: boolean;
}
interface PlanStep {
  kind: "agent" | "service" | "plugin" | "path-block" | "app-link" | "home" | "binary";
  target: string;
  paths: string[];
  action: string;
}
interface StepResult { kind: PlanStep["kind"]; target: string; status: "ok" | "failed"; details: string[] }
export interface UninstallAllDeps {
  tty?: boolean;
  print?: (text: string) => void;
  confirm?: (question: string) => Promise<boolean>;
  platform?: string;
  service?: (ctx: Ctx) => Pick<ServiceBackend, "uninstall">;
  agent?: typeof uninstallPlanner;
  plugin?: typeof uninstallPlugin;
  removeHome?: (path: string) => void;
  removeBinary?: (path: string) => void;
}
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
// Resolve existing ancestors too, so a missing leaf under a symlink is safe to check.
function canonical(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const parent = dirname(absolute);
    if (parent === absolute) throw e;
    return join(canonical(parent), absolute.slice(parent.length));
  }
}
function safeHome(ctx: Ctx): void {
  const path = canonical(ctx.pacerHome), home = canonical(ctx.home);
  if (path === "/" || path === home || home.startsWith(path + "/")) {
    throw new Error(`refusing to remove unsafe PACER_HOME ${ctx.pacerHome} (resolves to ${path})`);
  }
}
function binaryPath(ctx: Ctx): { path: string; deletable: boolean } {
  const argv = pacerArgv(ctx.env);
  // A source checkout runs under Bun: never offer to unlink the shared runtime.
  if (argv.length !== 1) return { path: process.execPath, deletable: false };
  const binary = isAbsolute(argv[0]) ? argv[0] : ctx.which(argv[0]);
  if (!binary) throw new Error(`cannot resolve pacer binary ${argv[0]}`);
  const path = resolve(binary);
  return { path, deletable: canonical(path) !== canonical(process.execPath) || !/^(bun|node)(?:\.exe)?$/.test(path.split("/").at(-1)!) };
}
function reportDetails(report: UninstallReport | null): string[] {
  if (!report) throw new Error("integration is no longer recorded in the install manifest");
  const failures = report.notes.filter(note => /^(?:cannot (?:restore|revert) |`.*` failed|left Orca plugin storage unchanged:)/.test(note));
  if (failures.length) throw new Error(failures.join("\n"));
  return [...report.restored.map(path => `restored ${path}`), ...report.removed.map(path => `removed ${path}`),
    ...report.reverted.map(path => `reverted ${path}`), ...report.notes];
}

function pathBlockEdit(path: string): { text: string; mode: number } | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || !(stat.mode & 0o222)) return null;
    accessSync(path, constants.W_OK);
    const edit = removePathBlock(readFileSync(path, "utf8"));
    return edit.removed ? { text: edit.text, mode: stat.mode & 0o7777 } : null;
  } catch (error) {
    if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

function removeRcPathBlock(path: string): void {
  // Recheck after confirmation; never follow a profile replaced by a symlink.
  const edit = pathBlockEdit(path);
  if (!edit) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, edit.text, { flag: "wx", mode: 0o600 });
  try {
    chmodSync(temporary, edit.mode);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function uninstallAll(args: string[], ctx: Ctx, deps: UninstallAllDeps = {}): Promise<Result> {
  if (!args.includes("--all") || args.some(arg => !["--all", "--yes", "--binary", "--force", "--json"].includes(arg))) {
    return { code: 2, out: "", err: `usage: pacer ${UNINSTALL_ALL_USAGE}` };
  }
  const json = args.includes("--json"), tty = deps.tty ?? !!process.stdin.isTTY;
  const plan: PlanStep[] = [], results: StepResult[] = [];
  let blockedByTasks: BlockingTask[] = [], warning: string | undefined;
  let printed = false;
  const renderPlan = () => ["Uninstall plan:", ...plan.map(step =>
    `  ${step.kind} ${step.target}: ${step.action}${step.paths.length ? `\n    ${step.paths.join("\n    ")}` : ""}`),
    ...(warning ? [`warning: ${warning}`] : [])].join("\n");
  const finish = (code: number, err = ""): Result => ({ code, err,
    out: json ? JSON.stringify({ plan, results, ...(blockedByTasks.length ? { blocked_by_tasks: blockedByTasks } : {}), ...(warning ? { warning } : {}) }, null, 2) : [printed ? "" : renderPlan(),
      ...results.map(step => `${step.status}: ${step.kind} ${step.target}${step.details.length ? `\n  ${step.details.join("\n  ")}` : ""}`)].filter(Boolean).join("\n") });
  try {
    const manifest = readManifest(ctx);
    for (const [key, record] of Object.entries(manifest.planners)) {
      if (key === "service" || key === PLUGIN_RECORD) continue;
      plan.push({ kind: "agent", target: key, paths: [...new Set([...(record.folder ? [record.folder] : []), ...record.files.map(file => file.path)])], action: "undo recorded integration (restore backups)" });
    }
    const platform = deps.platform ?? process.platform;
    const unit = servicePath(ctx, platform);
    if (existsSync(unit) || manifest.planners.service) plan.push({ kind: "service", target: unit, paths: [unit], action: "uninstall login service" });
    if (manifest.planners[PLUGIN_RECORD]) plan.push({ kind: "plugin", target: pluginDir(ctx), paths: manifest.planners[PLUGIN_RECORD].files.map(file => file.path), action: "undo Orca plugin registration; remove development path in Orca Settings if listed" });
    for (const rc of [".zshrc", ".bashrc"]) {
      const path = join(ctx.home, rc);
      if (pathBlockEdit(path)) plan.push({ kind: "path-block", target: path, paths: [path], action: `Remove the pacer PATH line from ~/${rc}` });
    }
    const link = appLink(ctx.home);
    if (link) plan.push({ kind: "app-link", target: link, paths: [link], action: "Remove the ~/.local/bin/pacer link to the pacer app" });
    plan.push({ kind: "home", target: resolve(ctx.pacerHome), paths: [], action: "remove PACER_HOME and all its contents" });
    const binary = binaryPath(ctx);
    plan.push({ kind: "binary", target: binary.path, paths: [], action: args.includes("--binary") ? "delete binary" : "left in place (use --binary to delete)" });
    const activeTasks = listTasks(ctx, Infinity)
      .filter(task => task.state === "running" || task.state === "queued")
      .map((task): BlockingTask => {
        const goal = [...task.brief.goal.replace(/\s+/g, " ").trim()];
        return { id: task.id, state: task.state, goal: goal.length > 60 ? goal.slice(0, 59).join("") + "…" : goal.join(""),
          ...(task.state === "running" && task.runnerPid !== undefined
            ? { runner_pid: task.runnerPid, runner_alive: pidAlive(task.runnerPid) } : {}) };
      });
    if (activeTasks.length) {
      const tasks = activeTasks.map(task => `  ${task.id} (${task.state}): ${task.goal}`).join("\n");
      // A stale supervisor PID does not prove its task data is safe to remove.
      if (!args.includes("--force")) {
        blockedByTasks = activeTasks;
        return finish(2, `pacer: refusing to uninstall while delegated tasks are running or queued:\n${tasks}\nStop them first (pacer stop <id>), wait for them, or rerun with --force.`);
      }
      warning = `forcing uninstall with running or queued delegated tasks:\n${tasks}`;
    }
    if (tty && !json) { (deps.print ?? console.log)(renderPlan()); printed = true; }
    safeHome(ctx);
    if (args.includes("--binary") && !binary.deletable) throw new Error("refusing to delete the Bun/Node runtime; run the installed pacer binary with --binary");
    const homePath = canonical(ctx.pacerHome);
    const binaryInsideHome = canonical(binary.path) === homePath || canonical(binary.path).startsWith(homePath + "/");
    if (!args.includes("--binary") && binaryInsideHome) {
      throw new Error("binary is inside PACER_HOME; rerun with --binary to approve its removal");
    }
    if (!args.includes("--yes")) {
      if (!tty) return finish(2, "pacer: non-TTY uninstall requires confirmation; rerun with --yes");
      const confirm = deps.confirm ?? (async (question: string) => {
        const rl = createInterface({ input: process.stdin, output: json ? process.stderr : process.stdout });
        try { return /^y(?:es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
      });
      // Keep stdout valid JSON while still showing the complete plan before confirmation.
      if (json) (deps.print ?? (text => process.stderr.write(text + "\n")))(renderPlan());
      if (!await confirm("Remove all of this? [y/N] ")) return finish(0, "pacer: uninstall cancelled");
    }
    for (const step of plan) {
      if (step.kind === "binary" && !args.includes("--binary")) continue;
      try {
        let details: string[] = [];
        switch (step.kind) {
          case "agent": details = reportDetails(await (deps.agent ?? uninstallPlanner)(ctx, step.target)); break;
          case "service": await (deps.service ?? (ctx => serviceBackend(ctx, { platform })))(ctx).uninstall(); break;
          case "plugin": details = reportDetails(await (deps.plugin ?? uninstallPlugin)(ctx)); break;
          case "path-block": removeRcPathBlock(step.target); break;
          case "app-link":
            if (appLink(ctx.home) === step.target) unlinkSync(step.target);
            break;
          case "home":
            // Integration backups live in PACER_HOME; keep it so a failed restore can be retried.
            if (results.some(r => r.kind === "agent" && r.status === "failed")) throw new Error("kept: an agent restore failed and its backups live here; fix it and rerun");
            safeHome(ctx);
            (deps.removeHome ?? (path => rmSync(path, { recursive: true, force: true })))(step.target);
            break;
          case "binary":
            if (!existsSync(step.target) && results.some(result => result.kind === "app-link" && result.target === step.target && result.status === "ok")) {
              details = ["removed with the app link"];
            } else if (binaryInsideHome && !existsSync(step.target) && results.some(result => result.kind === "home" && result.status === "ok")) {
              details = ["removed with PACER_HOME (--binary)"];
            } else (deps.removeBinary ?? unlinkSync)(step.target);
            break;
        }
        results.push({ kind: step.kind, target: step.target, status: "ok", details });
      } catch (e) { results.push({ kind: step.kind, target: step.target, status: "failed", details: [message(e)] }); }
    }
    return finish(results.some(step => step.status === "failed") ? 1 : 0);
  } catch (e) { return finish(1, `pacer: ${message(e)}`); }
}
