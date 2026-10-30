import { policySummary } from "../plugins/policy";
import { policyWords } from "../view-model/words";
import { plannerPreview } from "../plugins/planner-preview";
import { parseRunnerId, formatRunnerId, runnerDefaults } from "../config/runner-id";
import { readManifest } from "../install/manifest";
import { accountFolder } from "../install/role";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { agentPlans, AGENT_BINS, type AgentId } from "../install/detection";
import { detect, starterStrategy, plannerAccounts } from "../install/init";
import { PLANNERS, validateStrategy } from "../config/strategy";
import { editStrategy } from "../config/edit";
import { migrateStrategy, migrationLines } from "../config/migrate";
import { installPlanner } from "../install";
import { pacerArgv } from "../install/self";
import { serviceBackend, type ServiceBackend } from "../service";
import { dashboardClient } from "../dashboard/client";
import type { ApiClient } from "../api/client-types";
import type { SetupChecklist } from "../setup/checklist";
import type { TryResult } from "../onboarding/try";
import { runDashboard } from "../dashboard/cli";
import type { Ctx } from "../types";
import type { Result } from "./types";
export const INIT_USAGE = "init [--planner <id>] [--yes] [--service] [--agents a,b] [--no-dashboard] [--json]";
export const SETUP_USAGE = INIT_USAGE.replace(/^init/, "setup");
export interface SetupDeps {
  tty?: boolean; stdoutTTY?: boolean;
  onboardingClient?: (ctx: Ctx) => Promise<Pick<ApiClient, "call" | "close">>;
  confirm?: (plan: string) => Promise<boolean>; question?: (question: string) => Promise<string>;
  print?: (line: string) => void; service?: (ctx: Ctx) => Pick<ServiceBackend, "status" | "install">;
  dashboard?: typeof runDashboard;
}
export async function setupCmd(args: string[], ctx: Ctx, deps: SetupDeps = {}): Promise<Result> {
  let yes = false, installService = false, json = false, noDashboard = false, planner: string | undefined, selected: AgentId[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes") yes = true;
    else if (arg === "--service") installService = true;
    else if (arg === "--json") json = true;
    else if (arg === "--no-dashboard") noDashboard = true;
    else if (arg === "--force") { /* Kept for compatibility; existing strategies are preserved. */ }
    else if ((arg === "--planner" || arg === "--agents") && args[i + 1] && !args[i + 1].startsWith("--")) {
      const value = args[++i];
      if (arg === "--planner") {
        if (!parseRunnerId(value) || parseRunnerId(value)!.host || !(PLANNERS as readonly string[]).includes(parseRunnerId(value)!.agent)) return { code: 2, out: "", err: `unknown planner; choose ${PLANNERS.join(", ")}` };
        planner = value;
      } else {
        const ids = value.split(",");
        if (ids.some(id => !Object.hasOwn(AGENT_BINS, id))) return { code: 2, out: "", err: `unknown agent; choose ${Object.keys(AGENT_BINS).join(", ")}` };
        selected = [...new Set(ids)] as AgentId[];
      }
    } else return { code: 2, out: "", err: `usage: pacer ${INIT_USAGE}` };
  }
  const tty = !json && (deps.tty ?? !!process.stdin.isTTY);
  const lines: string[] = [];
  const print = (line: string) => { lines.push(line); if (tty) (deps.print ?? console.log)(line); };
  const question = deps.question ?? (async (text: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return await rl.question(text); } finally { rl.close(); }
  });
  try {
    const agents = await Promise.all(agentPlans(ctx.home,ctx.pacerHome,ctx.which,ctx.env).filter(a=>!selected||selected.includes(a.id)).map(async a=>({...a,...await plannerPreview(ctx,a.id,a.id==="opencode"?join(ctx.env.XDG_CONFIG_HOME??join(ctx.home,".config"),"opencode"):join(ctx.home,a.id==="claude-code"?".claude":`.${a.id}`),a.id,a.id==="codex"?ctx.env.CODEX_HOME:undefined)})));
    if (selected?.some(id => !agents.some(a => a.id === id))) return { code: 2, out: "", err: "requested agent CLI is not on PATH" };
    const path = join(ctx.pacerHome, "strategy.yaml");
    const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
    const strategy = existing ? validateStrategy(Bun.YAML.parse(existing), path) : undefined;
    const current = strategy ? formatRunnerId({...strategy.planner, host: null}, runnerDefaults(strategy.accounts)) : undefined;
    const detection = await detect(ctx);
    const detected = (Object.keys(AGENT_BINS) as AgentId[]).filter(id => AGENT_BINS[id].some(bin => ctx.which(bin)));
    if (!planner) {
      planner = current && (PLANNERS as readonly string[]).includes(parseRunnerId(current)?.agent ?? "") ? current : detected[0] ?? "claude-code";
      if (tty && detected.length > 1) {
        const choices = detected.includes(parseRunnerId(planner)!.agent as AgentId) ? detected : [...detected, parseRunnerId(planner)!.agent as AgentId];
        const defaultIndex = Math.max(0, choices.indexOf(parseRunnerId(planner)!.agent as AgentId));
        const answer = (await question(`Choose planner:\n${choices.map((id, i) => `${i + 1}. ${id}`).join("\n")}\nPlanner [${defaultIndex + 1}]: `)).trim();
        if (answer && (!/^\d+$/.test(answer) || !choices[Number(answer) - 1])) return { code: 2, out: "", err: "invalid planner choice" };
        planner = choices[answer ? Number(answer) - 1 : defaultIndex];
      }
    }
    if (strategy) {
      const id = parseRunnerId(planner)!;
      const choices = plannerAccounts(ctx, strategy, id.agent);
      const defaultIndex = Math.max(0, choices.findIndex(a => a.name === (id.account ?? (strategy.planner.agent === id.agent ? strategy.planner.account : runnerDefaults(strategy.accounts)[id.agent]))));
      if (tty && !args.includes("--planner") && choices.length > 1) {
        const answer = (await question(`Choose planner account for ${id.agent}:\n${choices.map((a, i) => `${i + 1}. ${a.name}`).join("\n")}\nAccount [${defaultIndex + 1}]: `)).trim();
        if (answer && (!/^\d+$/.test(answer) || !choices[Number(answer) - 1])) return {code: 2, out: "", err: "invalid planner account choice"};
        id.account = choices[answer ? Number(answer) - 1 : defaultIndex].name;
      } else if (!id.account && !args.includes("--planner") && strategy.planner.agent === id.agent) id.account = strategy.planner.account;
      if (!id.account && !args.includes("--planner") && choices.length === 1 && !runnerDefaults(strategy.accounts)[id.agent]) id.account = choices[0].name;
      planner = formatRunnerId(id, runnerDefaults(strategy.accounts));
    }
    if (!detected.length) print("No agent CLI was found. Default planner: claude-code. Choose another with: pacer init --planner <id>");
    print(`✓ Planner: ${planner}${current === planner ? " (already done)" : ""}`);
    if (existing) {
      validateStrategy(Bun.YAML.parse(existing), path);
      if (current !== planner) {
        const result = editStrategy(path, doc => doc.setScalar(["planner"], planner!));
        if (!result.ok) throw Error(result.error);
        print("✓ Strategy planner updated");
      } else print("✓ Strategy (already done)");
    } else {
      const text = starterStrategy(detection, planner);
      validateStrategy(Bun.YAML.parse(text), path); mkdirSync(ctx.pacerHome, { recursive: true }); writeFileSync(path, text); print(`✓ Strategy: ${path}`);
    }
    const service = (deps.service ?? serviceBackend)(ctx);
    let serviceInstalled = (await service.status()).installed;
    if (serviceInstalled) print("✓ Login service (already done)");
    else {
      const consent = yes || installService || (tty && /^(?:y(?:es)?)?$/i.test((await question("Run pacer in the background at login? It keeps budgets fresh and runs delegated tasks. [Y/n] ")).trim()));
      if (consent) { await service.install(); serviceInstalled = true; print("✓ Login service installed"); }
      else print("Login service: skipped (install later with: pacer service install)");
    }
    const results = [];
    for (const agent of agents) {
      const target = strategy && agent.id === parseRunnerId(planner!)?.agent && strategy.accounts[parseRunnerId(planner!)!.account ?? runnerDefaults(strategy.accounts)[agent.id] ?? ""]
        ? {agent: agent.id, account: parseRunnerId(planner!)!.account ?? runnerDefaults(strategy.accounts)[agent.id]!} : agent.id;
      const targetFolder = typeof target === "object" ? accountFolder(ctx, strategy!.accounts[target.account]) : null;
      const targetKey = targetFolder ? `${agent.id}#${typeof target === "object" ? target.account : ""}` : agent.id;
      const installed = targetFolder ? !!readManifest(ctx).planners[targetKey] : agent.installed;
      let connected = installed;
      if (!connected) {
        const detail = agent.id === "claude-code" ? (await plannerPreview(ctx,agent.id,targetFolder??join(ctx.home,".claude"))).detail : undefined;
        const preview = `${agent.name}:\n${(targetFolder ? [targetFolder] : agent.files).join("\n")}${detail ? `\n${detail}` : ""}\nUndo: ${targetFolder ? `pacer uninstall ${targetKey}` : agent.undo}\nNo MCP servers will be added.`;
        print(preview);
        const consent = yes || (!tty && !!selected) || (tty && (deps.confirm ? await deps.confirm(preview) : /^y(?:es)?$/i.test((await question(`Connect ${agent.name}? [y/N] `)).trim())));
        if (consent) { await installPlanner({ ctx, pacerArgv: pacerArgv(ctx.env), mcp: false }, target); connected = true; }
      }
      print(connected ? `✓ ${agent.name}${installed ? " (already done)" : " connected"}` : `${agent.name}: skipped`);
      results.push({ ...agent, installed: connected, status: connected ? installed ? "already connected" : "connected" : "skipped" });
    }
    const migration = migrationLines(path, migrateStrategy(path));
    migration.forEach(print);
    const policy = policySummary(ctx);
    print(policyWords(policy));
    print(`Setup: planner ${planner}; strategy ready; login service ${serviceInstalled ? "installed" : "skipped"}; ${results.filter(a => a.installed).length} agents connected.`);
    print("Next:\n  Ask your planner for some work and it will delegate.\n  pacer open — watch work and budgets\n  pacer doctor — check your setup");
    if (tty) {
      // Best effort: the offer needs the service, which the user may have just declined.
      let client: Pick<ApiClient, "call" | "close"> | undefined;
      try { client = await (deps.onboardingClient ?? dashboardClient)(ctx); } catch { print("Try a first delegation later: pacer open, or press t in pacer dashboard."); }
      if (client) try {
        const checklist = await client.call<SetupChecklist>("setup.check", {});
        if (checklist.items.some(i => i.id === "executor" && i.status === "done") && checklist.items.some(i => i.id === "first" && i.status !== "done")) {
          const answer = (await question("Try a first delegation now? It runs a tiny docs task in a scratch repo. [Y/n] ")).trim();
          if (/^(?:y(?:es)?)?$/i.test(answer)) {
            const task = await client.call<TryResult>("onboarding.try", {});
            print(`Started ${task.task_id} on ${task.executor}. Review it with: pacer review ${task.task_id} (or in pacer open)`);
          } else await client.call("onboarding.skip", {});
        }
      } catch (e) { print(`First delegation not started: ${(e as Error).message}`); } finally { client.close(); }
    }
    if (tty && (deps.stdoutTTY ?? !!process.stdout.isTTY) && !noDashboard) {
      // Flush the setup summary before dashboard owns stdout.
      if (!tty) (deps.print ?? console.log)(lines.join("\n"));
      return (deps.dashboard ?? runDashboard)([], ctx);
    }
    return { code: 0, out: json ? JSON.stringify({ policy, planner, strategy: path, service: serviceInstalled, agents: results, applied: true, migration }) : tty ? "" : lines.join("\n"), err: "" };
  } catch (e) { return { code: 1, out: json ? "" : tty ? "" : lines.join("\n"), err: `pacer init: ${(e as Error).message}` }; }
}
