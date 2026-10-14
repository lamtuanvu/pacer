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
import { installPlugin, pluginDir, MANAGED_MARKER } from "../plugin/install";
import { readLiveHeartbeat } from "../plugin/live";
import { runDashboard } from "../dashboard/cli";
import type { Ctx } from "../types";
import type { Result } from "./types";
export const INIT_USAGE = "init [--planner <id>] [--yes] [--agents a,b] [--no-dashboard] [--json]";
export const SETUP_USAGE = INIT_USAGE.replace(/^init/, "setup");
export interface SetupDeps {
  tty?: boolean; stdoutTTY?: boolean;
  confirm?: (plan: string) => Promise<boolean>; question?: (question: string) => Promise<string>;
  print?: (line: string) => void; service?: (ctx: Ctx) => Pick<ServiceBackend, "status" | "install">;
  orcaInstalled?: boolean; plugin?: typeof installPlugin; dashboard?: typeof runDashboard;
  waitLive?: (pacerHome: string, print: (line: string) => void) => Promise<boolean>;
}
/** Polling and skip IO are injectable so tests never wait five minutes. */
export async function waitForLive(pacerHome: string, print: (line: string) => void, deps: {
  now?: () => number; live?: () => boolean; sleep?: (ms: number) => Promise<void>; skip?: Promise<void>;
} = {}): Promise<boolean> {
  const now = deps.now ?? (() => Date.now() / 1000), live = deps.live ?? (() => !!readLiveHeartbeat(pacerHome));
  const start = now(); let skipped = false;
  let rl: ReturnType<typeof createInterface> | undefined;
  const skip = deps.skip ?? new Promise<void>(resolve => {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", () => resolve()); rl.on("close", () => resolve());
    void rl.question("Press Enter to finish later.\n").then(() => resolve(), () => resolve());
  });
  void skip.then(() => { skipped = true; });
  try {
    while (now() - start < 300) {
      if (live()) return true;
      if (skipped) return false;
      print(`Waiting for the live panel… ${Math.floor(now() - start)}s / 300s`);
      await Promise.race([(deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1000), skip]);
    }
    return false;
  } finally { rl?.close(); }
}
export async function setupCmd(args: string[], ctx: Ctx, deps: SetupDeps = {}): Promise<Result> {
  let yes = false, json = false, noDashboard = false, planner: string | undefined, selected: AgentId[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes") yes = true;
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
    const agents = agentPlans(ctx.home, ctx.pacerHome, ctx.which, ctx.env).filter(a => !selected || selected.includes(a.id));
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
    if ((await service.status()).installed) print("✓ Login service (already done)");
    else { await service.install(); print("✓ Login service installed"); }
    const results = [];
    for (const agent of agents) {
      const target = strategy && agent.id === parseRunnerId(planner!)?.agent && strategy.accounts[parseRunnerId(planner!)!.account ?? runnerDefaults(strategy.accounts)[agent.id] ?? ""]
        ? {agent: agent.id, account: parseRunnerId(planner!)!.account ?? runnerDefaults(strategy.accounts)[agent.id]!} : agent.id;
      const targetFolder = typeof target === "object" ? accountFolder(ctx, strategy!.accounts[target.account]) : null;
      const targetKey = targetFolder ? `${agent.id}#${typeof target === "object" ? target.account : ""}` : agent.id;
      const installed = targetFolder ? !!readManifest(ctx).planners[targetKey] : agent.installed;
      let connected = installed;
      if (!connected) {
        const preview = `${agent.name}:\n${(targetFolder ? [targetFolder] : agent.files).join("\n")}\nUndo: ${targetFolder ? `pacer uninstall ${targetKey}` : agent.undo}\nNo MCP servers will be added.`;
        print(preview);
        const consent = yes || (!tty && !!selected) || (tty && (deps.confirm ? await deps.confirm(preview) : /^y(?:es)?$/i.test((await question(`Connect ${agent.name}? [y/N] `)).trim())));
        if (consent) { await installPlanner({ ctx, pacerArgv: pacerArgv(ctx.env), mcp: false }, target); connected = true; }
      }
      print(connected ? `✓ ${agent.name}${installed ? " (already done)" : " connected"}` : `${agent.name}: skipped`);
      results.push({ ...agent, installed: connected, status: connected ? installed ? "already connected" : "connected" : "skipped" });
    }
    let live = !!readLiveHeartbeat(ctx.pacerHome);
    const orcaInstalled = deps.orcaInstalled ?? !!(ctx.env.ORCA_CLI_COMMAND || ctx.which("orca") || existsSync("/Applications/Orca.app/Contents/Resources/bin/orca"));
    if (orcaInstalled) {
      const already = existsSync(join(pluginDir(ctx), MANAGED_MARKER));
      await (deps.plugin ?? installPlugin)({ ctx, pacerArgv: pacerArgv(ctx.env) });
      print(`✓ Orca live panel installed${already ? " (already done)" : ""}`);
      if (!live) {
        if (process.platform === "darwin" && ctx.which("pbcopy")) {
          try { const { spawn } = await import("node:child_process"); await new Promise<void>(resolve => { const child = spawn(ctx.which("pbcopy")!, [], { env: ctx.env }); child.on("error", () => resolve()); child.on("close", () => resolve()); child.stdin.on("error", () => {}); child.stdin.end(pluginDir(ctx)); }); } catch {}
        }
        print("Last step: turn on the live panel. In Orca: Settings > Plugins > Development > Add folder, paste the path (copied to your clipboard), then enable pacer.");
        print(pluginDir(ctx));
        if (tty) live = await (deps.waitLive ?? waitForLive)(ctx.pacerHome, print);
        if (!live) print("Finish later with: pacer init");
      }
      if (live) print("✓ Live panel connected");
    }
    const migration = migrationLines(path, migrateStrategy(path));
    migration.forEach(print);
    print(`Setup: planner ${planner}; strategy ready; login service installed; ${results.filter(a => a.installed).length} agents connected; live panel ${live ? "connected" : "pending"}.`);
    if (tty && (deps.stdoutTTY ?? !!process.stdout.isTTY) && !noDashboard) {
      // Flush the setup summary before dashboard owns stdout.
      if (!tty) (deps.print ?? console.log)(lines.join("\n"));
      return (deps.dashboard ?? runDashboard)([], ctx);
    }
    return { code: 0, out: json ? JSON.stringify({ planner, strategy: path, service: true, agents: results, live, applied: true, migration }) : tty ? "" : lines.join("\n"), err: "" };
  } catch (e) { return { code: 1, out: json ? "" : tty ? "" : lines.join("\n"), err: `pacer init: ${(e as Error).message}` }; }
}
