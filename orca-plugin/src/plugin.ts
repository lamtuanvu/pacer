import { join } from "node:path";
import { clip, LIMITS, liveConsole, summaryLine, type CmdData } from "../../src/link/envelope";
import type { AgentStatusChanged, OrcaWorkerContext, WorktreeCreated } from "./orca-api";
import { readSettings } from "./settings";
import { LinkStore } from "./store";
import { chooseTransport, type Transport } from "./transports/choose";
import { httpTransport, type HttpPort } from "./transports/http";
import { bridgeTransport } from "./transports/bridge";
import { channelTransport } from "./transports/channel";
import { NO_CONSOLE, sendToConsole, focusedConsole } from "./console-link";
import { notifyNewAlerts } from "./notify";
import { renderPanel, type AutoConsoleOutcome } from "./panel";
export interface Timers { every(ms: number, fn: () => void): () => void; after(ms: number, fn: () => void): () => void }
export interface PluginDeps {
  nowS(): number;
  timers: Timers;
  http: HttpPort;
  fs: { readText(path: string): string | null; writeTextAtomic(path: string, text: string): void; exists(path: string): boolean };
  home: string;
  pluginRoot: string;
}
export function createPlugin(deps: PluginDeps): { activate(ctx: OrcaWorkerContext): Promise<void>; deactivate(): Promise<void> } {
  let stopped = false;
  let stopWatch: (() => void) | null = null;
  let cancelRender: (() => void) | null = null;
  let cancelRetry: (() => void) | null = null;
  const timerCancels = new Set<() => void>();
  const timers: Timers = {
    every(ms, fn) { const cancel = deps.timers.every(ms, fn); timerCancels.add(cancel); return () => { cancel(); timerCancels.delete(cancel); }; },
    after(ms, fn) { let cancel: () => void; cancel = deps.timers.after(ms, () => { timerCancels.delete(cancel); fn(); }); timerCancels.add(cancel); return () => { cancel(); timerCancels.delete(cancel); }; },
  };
  async function activate(ctx: OrcaWorkerContext): Promise<void> {
    stopped = false;
    const activatedAtS = deps.nowS();
    let raw: Record<string, unknown> = {};
    // Settings are host IPC, but cannot consume the worker's one-second ready budget.
    let cancelSettings = () => {};
    try {
      const result = await Promise.race([
        ctx.host.call("settings.get"),
        new Promise<{ settings: Record<string, unknown> }>(resolve => {
          cancelSettings = timers.after(500, () => resolve({ settings: {} }));
        }),
      ]);
      raw = result.settings;
    } catch { /* settings capability may be unavailable */ }
    finally { cancelSettings(); }
    if (stopped) return;
    const settings = readSettings(raw, deps.home);
    const store = new LinkStore(deps.nowS);
    const bridge = bridgeTransport({ host: ctx.host, pollMs: settings.pollSeconds * 1000, timers });
    const transports = [
      httpTransport({ http: deps.http, readToken: () => deps.fs.readText(`${settings.pacerHome}/token`)?.trim() || null, port: settings.port, timers }),
      channelTransport({ host: ctx.host, registerEvent: (name, handler) => ctx.events.on(name, async payload => { await ensureConnected(); if (!stopped) handler(payload); }) }),
      bridge,
    ];
    let active: Transport | null = null, reachable = false, connecting: Promise<void> | null = null;
    let processing = Promise.resolve();
    let httpFailures = 0;
    let renderedKey: string | null = null;
    const outcomes = new Map<string, AutoConsoleOutcome>();
    let focusedWorktree: string | null = null, attempted = false;
    const panelOutcome = (): AutoConsoleOutcome => (focusedWorktree ? outcomes.get(focusedWorktree) : undefined) ?? { status: "starting", at: activatedAtS };
    const hintKey = () => {
      if (!settings.autoConsole || active?.id !== "http" || !reachable) return null;
      const outcome = focusedWorktree ? outcomes.get(focusedWorktree) : undefined;
      const hasLive = [...(store.snapshot.consoles ?? []), ...(store.snapshot.console ? [store.snapshot.console] : [])].some(c => c.handle && deps.nowS()-c.heartbeatAt <= LIMITS.heartbeatS);
      if ((outcome?.status === "registered" || !outcome) && hasLive) return null;
      const current = panelOutcome();
      return { ...current, expired: current.status === "starting" && deps.nowS()-current.at >= 15 };
    };
    const panelKey = () => JSON.stringify({
      budget: store.snapshot.budget ? { ...store.snapshot.budget, generatedAt: undefined } : null,
      mode: store.snapshot.mode ? { ...store.snapshot.mode, at: undefined } : null,
      tasks: store.snapshot.tasks, alerts: store.snapshot.alerts,
      consoles: [...new Set([...(store.snapshot.consoles ?? []).map(c=>c.handle), store.snapshot.console?.handle].filter(Boolean))].sort().map(handle => ({
        handle, live: [...(store.snapshot.consoles ?? []), ...(store.snapshot.console ? [store.snapshot.console] : [])].some(c => c.handle === handle && deps.nowS() - c.heartbeatAt <= LIMITS.heartbeatS),
      })), autoConsoleOutcome: hintKey(), strategies: store.snapshot.strategies, transport: store.transport, reachable,
    });
    const logError = (e: unknown) => ctx.log(`pacer: ${e instanceof Error ? e.message : String(e)}`);
    const scheduleRender = () => {
      if (stopped || cancelRender) return;
      cancelRender = timers.after(2000, () => {
        cancelRender = null;
        if (stopped) return;
        try {
          const key = panelKey(), nowS = deps.nowS();
          if (key !== renderedKey) {
            if (deps.fs.exists(join(deps.pluginRoot, ".pacer-managed"))) {
              deps.fs.writeTextAtomic(join(deps.pluginRoot, "panel", "live.html"), renderPanel(store.snapshot, { nowS, transport: store.transport, reachable, autoConsole: settings.autoConsole, autoConsoleOutcome: panelOutcome() }));
              renderedKey = key;
            } else ctx.log("pacer: refused panel write: unmanaged root");
          }
        } catch (e) { logError(e); }
        const snapshot = store.snapshot;
        processing = processing.then(async () => { if (!stopped) await notifyNewAlerts(ctx.host, snapshot, settings, activatedAtS); }).catch(logError);
      });
    };
    store.onChange(scheduleRender);
    timers.every(15000, () => { if (panelKey() !== renderedKey) scheduleRender(); });
    const replaceSnapshot = (snapshot: Parameters<LinkStore["replace"]>[0]) => {
      if (stopped) return;
      store.replace(snapshot);
    };
    const acceptSnapshot = (snapshot: Parameters<LinkStore["replace"]>[0]) => {
      if (stopped) return;
      httpFailures = 0;
      if (!reachable) { reachable = true; scheduleRender(); }
      replaceSnapshot(snapshot);
    };
    const connect = async () => {
      const chosen = await chooseTransport(transports, settings.transport);
      if (stopped) return;
      active = chosen.transport; reachable = chosen.reachable; store.transport = active?.id ?? null;
      if (!active) {
        scheduleRender();
        cancelRetry = timers.after(settings.pollSeconds * 1000, () => { cancelRetry = null; void ensureConnected(); });
        return;
      }
      const snapshot = await active.snapshot().catch(() => null) ?? await bridge.snapshot();
      if (stopped) return;
      if (snapshot) replaceSnapshot(snapshot);
      stopWatch = active.watch(e => { if (!stopped) store.apply(e); }, acceptSnapshot, () => { void handleHttpFailure().catch(logError); });
      scheduleRender();
    };
    function ensureConnected(): Promise<void> {
      if (stopped || stopWatch) return Promise.resolve();
      if (!connecting) {
        cancelRetry?.(); cancelRetry = null;
        connecting = connect().catch(logError).finally(() => { connecting = null; });
      }
      return connecting;
    }
    const notify = async (title: string, body?: string) => {
      try { await ctx.host.call("notifications.show", { title: clip(title, 120), ...(body === undefined ? {} : { body: clip(body, 1000) }) }); } catch (e) { logError(e); }
    };
    const handleHttpFailure = async () => {
      const failures = ++httpFailures;
      const snapshot = await bridge.snapshot();
      if (snapshot) replaceSnapshot(snapshot);
      if (stopped || active?.id !== "http") return;
      reachable = false;
      if (failures >= 3) {
        stopWatch?.(); stopWatch = null; httpFailures = 0;
        await ensureConnected();
      }
      scheduleRender();
    };
    const refreshSnapshot = async () => {
      try {
        const snapshot = await active?.snapshot().catch(() => null);
        if (snapshot) acceptSnapshot(snapshot);
        else if (active?.id === "http") await handleHttpFailure();
        else { const fallback = await bridge.snapshot(); if (fallback) replaceSnapshot(fallback); }
      } catch (e) { logError(e); }
    };
    // Re-probe higher priority transports so a recovered server replaces the bridge.
    let probing = false;
    timers.every(settings.pollSeconds * 1000, () => {
      if (stopped || probing || connecting || active?.id === "http") return;
      probing = true;
      void (async () => {
        if (active?.id === "channel") await refreshSnapshot();
        if (stopped || settings.transport !== "auto") return;
        const chosen = await chooseTransport(transports, settings.transport);
        if (stopped || chosen.transport?.id === active?.id) return;
        stopWatch?.(); stopWatch = null;
        await ensureConnected();
      })().catch(logError).finally(() => { probing = false; });
    });
    const failureLogged = new Map<string, number>();
    let opening = false;
    timers.every(5000, () => {
      if (stopped || opening || !settings.autoConsole || active?.id !== "http" || !reachable) return;
      opening = true;
      let worktree = "unknown";
      void (async () => {
        const context = await ctx.host.call("workspace.readContext");
        if (stopped) return;
        if (!context || !context.branch) { focusedWorktree = null; attempted = false; scheduleRender(); return; }
        worktree = context.worktreeId || context.branch;
        if (focusedWorktree !== worktree) { focusedWorktree = worktree; attempted = false; outcomes.delete(worktree); scheduleRender(); }
        const now = deps.nowS(), ids = new Set(context.terminals.map(t => t.id));
        if ([...(store.snapshot.consoles ?? []), ...(store.snapshot.console ? [store.snapshot.console] : [])].some(c => c.handle && ids.has(c.handle) && now - c.heartbeatAt <= LIMITS.heartbeatS)) {
          if (outcomes.get(worktree)?.status !== "registered") { outcomes.set(worktree, { status: "registered", at: now }); scheduleRender(); } return;
        }
        if (attempted) {
          const outcome = outcomes.get(worktree);
          if (outcome?.status === "registered" || (outcome?.status === "starting" && now-outcome.at >= 30)) {
            outcomes.set(worktree, { status: "gave-up", at: now }); scheduleRender();
          }
          return;
        }
        attempted = true; outcomes.set(worktree, { status: "starting", at: now }); scheduleRender();
        // Verify the loopback listener's identity immediately before sending the bearer token.
        const base = `http://127.0.0.1:${settings.port}`;
        const health = await deps.http.get(`${base}/health`, "", 1500);
        if (stopped || active?.id !== "http") return;
        if (health.status !== 200 || health.headers?.["x-pacer"] !== "1") throw new Error("unidentified HTTP listener");
        const token = deps.fs.readText(`${settings.pacerHome}/token`)?.trim();
        if (!token || !deps.http.post) throw new Error("HTTP console opening unavailable");
        const response = await deps.http.post(`${base}/console/open`, token, { ...(context.terminals[0] ? { terminal: context.terminals[0].id } : {}), branch: context.branch }, 1500);
        if (response.headers?.["x-pacer"] !== "1") throw new Error(`HTTP ${response.status}`);
        const result = JSON.parse(response.body);
        if (!result.ok) {
          outcomes.set(worktree, { status: typeof result.reason === "string" ? result.reason : "orca-unavailable", at: deps.nowS() }); scheduleRender();
        } else if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      })().catch(e => {
        const now = deps.nowS();
        outcomes.set(worktree, { status: "orca-unavailable", at: now }); scheduleRender();
        if (now - (failureLogged.get(worktree) ?? -Infinity) >= 300) {
          failureLogged.set(worktree, now); ctx.log(`pacer: auto console in ${worktree}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }).finally(() => { opening = false; });
    });
    const sendFresh = async (data: CmdData) => {
      await refreshSnapshot();
      if (stopped) return "no-console" as const;
      return sendToConsole(ctx.host, store.snapshot, data, deps.nowS());
    };
    const send = async (data: CmdData) => {
      const result = await sendFresh(data);
      if (result === "no-console") { await notify(NO_CONSOLE.title, NO_CONSOLE.body); return { ok: false, message: NO_CONSOLE.title }; }
      if (result === "rejected") {
        const message = "Orca refused to type into the pacer console";
        await notify(message, "Focus the console's worktree and retry, or run `pacer console --open` here.");
        return { ok: false, message };
      }
      const message = "Sent to pacer console"; await notify(message); return { ok: true, message };
    };
    ctx.commands.register("delegate", async () => {
      await ensureConnected();
      let context = null;
      try { context = await ctx.host.call("workspace.readContext"); } catch (e) { logError(e); }
      return send({ cmd: "delegate", ...(context ? { branch: context.branch, displayName: context.displayName, ...(context.worktreeId ? {worktreeId:context.worktreeId} : {}) } : {}) });
    });
    ctx.commands.register("switch-strategy", async () => { await ensureConnected(); return send({ cmd: "use" }); });
    ctx.commands.register("refresh-status", async () => {
      await ensureConnected();
      const result = await sendFresh({ cmd: "refresh" });
      if (result === "rejected") await notify("Orca refused to type into the pacer console", "Focus the console's worktree and retry, or run `pacer console --open` here.");
      scheduleRender();
      const message = summaryLine(store.snapshot.budget);
      await notify(message, (store.snapshot.budget?.providers ?? []).map(p => `${p.id} ${p.verdict} ${p.usedPct === null ? "?" : `${Math.round(p.usedPct)}%`}`).join("\n"));
      return { ok: true, message };
    });
    ctx.commands.register("open-console", async () => {
      await ensureConnected();
      await refreshSnapshot();
      const c = await focusedConsole(ctx.host, store.snapshot, deps.nowS());
      const message = c ? "pacer console is running" : NO_CONSOLE.title;
      await notify(message, c ? `terminal ${c.handle}` : NO_CONSOLE.body);
      return { ok: !!c, message };
    });
    const paneLast = new Map<string, number>(); let lastDone = -Infinity;
    ctx.events.on("agent.status.changed", async payload => {
      await ensureConnected();
      if (!payload || typeof payload !== "object") return;
      const p = payload as AgentStatusChanged;
      if (p.state !== "done" || (p.mainAgent?.state ?? "done") !== "done" || typeof p.paneKey !== "string") return;
      await refreshSnapshot();
      const now = deps.nowS();
      if (stopped || now - lastDone < 5 || now - (paneLast.get(p.paneKey) ?? -Infinity) < 5 || !liveConsole(store.snapshot, now)) return;
      // Reserve the debounce window before terminal IPC can yield.
      lastDone = now; paneLast.set(p.paneKey, now);
      await sendToConsole(ctx.host, store.snapshot, { cmd: "agent-done", paneKey: p.paneKey, ...(typeof p.worktreeId === "string" ? { worktreeId: p.worktreeId } : {}) }, now);
    });
    ctx.events.on("worktree.created", async payload => {
      await ensureConnected();
      if (!payload || typeof payload !== "object") return;
      const p = payload as WorktreeCreated;
      if (typeof p.branch !== "string" || !/(^|\/)pacer-/.test(p.branch) || typeof p.worktreeId !== "string" || typeof p.path !== "string") return;
      await sendFresh({ cmd: "worktree-created", worktreeId: p.worktreeId, path: p.path, branch: p.branch });
    });
    try { void ctx.host.call("events.subscribe", { events: ["agent.status.changed", "worktree.created"] }).catch(logError); }
    catch (e) { logError(e); }
    void ensureConnected();
  }
  return {
    activate,
    async deactivate() {
      stopped = true; stopWatch?.(); stopWatch = null; cancelRender?.(); cancelRender = null; cancelRetry?.(); cancelRetry = null;
      for (const cancel of timerCancels) cancel(); timerCancels.clear();
    },
  };
}
