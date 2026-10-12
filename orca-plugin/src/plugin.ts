import { clip, liveConsole, summaryLine, type CmdData } from "../../src/link/envelope";
import type { AgentStatusChanged, OrcaWorkerContext, WorktreeCreated } from "./orca-api";
import { readSettings } from "./settings";
import { LinkStore } from "./store";
import { chooseTransport, type Transport } from "./transports/choose";
import { httpTransport, type HttpPort } from "./transports/http";
import { bridgeTransport } from "./transports/bridge";
import { channelTransport } from "./transports/channel";
import { NO_CONSOLE, sendToConsole } from "./console-link";
import { notifyNewAlerts } from "./notify";
import { renderPanel } from "./panel";
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
    const logError = (e: unknown) => ctx.log(`pacer: ${e instanceof Error ? e.message : String(e)}`);
    const scheduleRender = () => {
      if (stopped || cancelRender) return;
      cancelRender = timers.after(2000, () => {
        cancelRender = null;
        if (stopped) return;
        try {
          if (deps.fs.exists(`${deps.pluginRoot}/.pacer-managed`)) deps.fs.writeTextAtomic(`${deps.pluginRoot}/panel/live.html`, renderPanel(store.snapshot, { nowS: deps.nowS(), transport: store.transport, reachable }));
        } catch (e) { logError(e); }
        const snapshot = store.snapshot;
        processing = processing.then(async () => { if (!stopped) await notifyNewAlerts(ctx.host, snapshot, settings, activatedAtS); }).catch(logError);
      });
    };
    store.onChange(scheduleRender);
    const connect = async () => {
      const chosen = await chooseTransport(transports, settings.transport);
      if (stopped) return;
      active = chosen.transport; reachable = chosen.reachable; store.transport = active?.id ?? null;
      if (!active) {
        scheduleRender();
        cancelRetry = timers.after(settings.pollSeconds * 1000, () => { cancelRetry = null; void ensureConnected(); });
        return;
      }
      const snapshot = await active.snapshot() ?? await bridge.snapshot();
      if (stopped) return;
      if (snapshot) store.replace(snapshot);
      stopWatch = active.watch(e => { if (!stopped) store.apply(e); }, s => { if (!stopped) store.replace(s); });
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
    const send = async (data: CmdData) => {
      const result = await sendToConsole(ctx.host, store.snapshot, data, deps.nowS());
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
      return send({ cmd: "delegate", ...(context ? { branch: context.branch, displayName: context.displayName } : {}) });
    });
    ctx.commands.register("switch-strategy", async () => { await ensureConnected(); return send({ cmd: "use" }); });
    ctx.commands.register("refresh-status", async () => {
      await ensureConnected();
      const s = await active?.snapshot(); if (s) store.replace(s);
      if (liveConsole(store.snapshot, deps.nowS())) {
        const result = await sendToConsole(ctx.host, store.snapshot, { cmd: "refresh" }, deps.nowS());
        if (result === "rejected") await notify("Orca refused to type into the pacer console", "Focus the console's worktree and retry, or run `pacer console --open` here.");
      }
      const message = summaryLine(store.snapshot.budget);
      await notify(message, (store.snapshot.budget?.providers ?? []).map(p => `${p.id} ${p.verdict} ${p.usedPct === null ? "?" : `${Math.round(p.usedPct)}%`}`).join("\n"));
      return { ok: true, message };
    });
    ctx.commands.register("open-console", async () => {
      await ensureConnected();
      const c = liveConsole(store.snapshot, deps.nowS());
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
      const now = deps.nowS();
      if (now - lastDone < 5 || now - (paneLast.get(p.paneKey) ?? -Infinity) < 5 || !liveConsole(store.snapshot, now)) return;
      lastDone = now; paneLast.set(p.paneKey, now);
      await sendToConsole(ctx.host, store.snapshot, { cmd: "agent-done", paneKey: p.paneKey, ...(typeof p.worktreeId === "string" ? { worktreeId: p.worktreeId } : {}) }, now);
    });
    ctx.events.on("worktree.created", async payload => {
      await ensureConnected();
      if (!payload || typeof payload !== "object") return;
      const p = payload as WorktreeCreated;
      if (typeof p.branch !== "string" || !/(^|\/)pacer-/.test(p.branch) || typeof p.worktreeId !== "string" || typeof p.path !== "string" || !liveConsole(store.snapshot, deps.nowS())) return;
      await sendToConsole(ctx.host, store.snapshot, { cmd: "worktree-created", worktreeId: p.worktreeId, path: p.path, branch: p.branch }, deps.nowS());
    });
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
