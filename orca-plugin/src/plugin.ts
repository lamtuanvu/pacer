import { notifyUpdates, UPDATE_INTERVAL_MS, type PluginUpdates } from "./updates";
import { updateAvailable, type UpdateCheck } from "../../src/update/check";
import { pluginMode } from "./mode";
import type { Bootstrap } from "./bootstrap";
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
import { notifyNewAlerts, deliverNotification } from "./notify";
import { renderPanel, type AutoConsoleOutcome } from "./panel";
export interface Timers { every(ms: number, fn: () => void): () => void; after(ms: number, fn: () => void): () => void }
export interface PluginDeps {
  version?: string;
  cachedUpdate?(): UpdateCheck | null;
  checkUpdates?(): Promise<{check: UpdateCheck | null; cli: string | null}>;
  reportVersion?(mode: "live" | "bootstrap", version: string): void;
  bootstrap?: Bootstrap;
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
    const mode = pluginMode(deps.pluginRoot, deps.fs);
    let updates: PluginUpdates | undefined;
    let updateBusy = false;
    const runUpdateCheck = async () => {
      if (stopped || updateBusy || !deps.checkUpdates || !deps.version) return;
      updateBusy = true;
      try {
        try { deps.reportVersion?.(mode, deps.version); } catch (e) { ctx.log(`pacer plugin version: ${String(e)}`); }
        const {check, cli} = await deps.checkUpdates();
        if (!stopped) updates = await notifyUpdates(ctx.host, mode, deps.version, check, cli);
      } catch (e) { ctx.log(`pacer update check: ${String(e)}`); }
      finally { updateBusy = false; }
    };
    void runUpdateCheck();
    timers.every(UPDATE_INTERVAL_MS, () => { void runUpdateCheck(); });
    if (pluginMode(deps.pluginRoot, deps.fs) === "bootstrap") {
      const logError = (e: unknown) => ctx.log(`pacer bootstrap: ${e instanceof Error ? e.message : String(e)}`);
      if (deps.bootstrap) {
        const ready = deps.bootstrap.activate(ctx);
        const run = async () => { await ready; if (!stopped) await deps.bootstrap!.run(ctx, () => {}); };
        void run().catch(logError);
        timers.every(60000, () => { void run().catch(logError); });
      }
      return;
    }
    const activatedAtS = deps.nowS();
    let raw: Record<string, unknown> = {};
    let settingsReady=false;
    // Settings are host IPC, but cannot consume the worker's one-second ready budget.
    let cancelSettings = () => {};
    try {
      const result = await Promise.race([
        ctx.host.call("settings.get").then(result=>{settingsReady=true;return result;}),
        new Promise<{ settings: Record<string, unknown> }>(resolve => {
          cancelSettings = timers.after(500, () => resolve({ settings: {} }));
        }),
      ]);
      raw = result.settings;
    } catch { /* settings capability may be unavailable */ }
    finally { cancelSettings(); }
    if (stopped) return;
    const settings = readSettings(raw, deps.home);
    settings.settingsReady=settingsReady;
    const store = new LinkStore(deps.nowS);
    const bridge = bridgeTransport({ host: ctx.host, pollMs: settings.pollSeconds * 1000, timers });
    const transports = [
      httpTransport({ http: deps.http, readToken: () => deps.fs.readText(`${settings.pacerHome}/token`)?.trim() || null, port: settings.port, timers }),
      channelTransport({ host: ctx.host, registerEvent: (name, handler) => ctx.events.on(name, async payload => { await ensureConnected(); if (!stopped) handler(payload); }) }),
      bridge,
    ];
    let active: Transport | null = null, reachable = false, connecting: Promise<void> | null = null;
    let lastSeenAt: number | undefined;
    const reconnecting = () => !reachable && lastSeenAt !== undefined && deps.nowS()-lastSeenAt < 20;
    let processing = Promise.resolve();
    let httpFailures = 0;
    let renderedKey: string | null = null;
    let lastRenderAt=-Infinity;
    let userOutcome=false;
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
    const panelUpdates = (): PluginUpdates | undefined => {
      if (!deps.version) return updates;
      const cached = deps.cachedUpdate?.();
      const latest = cached?.latest ?? updates?.latest ?? null;
      const cli = store.snapshot.console?.version ?? updates?.cli ?? null;
      const check = { checkedAt: deps.nowS(), latest, current: deps.version };
      return { plugin: deps.version, cli, latest, available: updateAvailable(check) || (!!cli && updateAvailable({...check,current:cli})) };
    };
    const panelKey = () => JSON.stringify({
      updates: panelUpdates(), bootstrap: deps.bootstrap?.state, notifications:settings.notifications,
      budget: store.snapshot.budget ? { ...store.snapshot.budget, generatedAt: undefined } : null,
      mode: store.snapshot.mode ? { ...store.snapshot.mode, at: undefined } : null,
      serviceInstalled: store.snapshot.serviceInstalled, reconnecting: reconnecting(), tasks: store.snapshot.tasks.map(({updatedAt,...task})=>task), alerts: store.snapshot.alerts,
      consoles: [...new Set([...(store.snapshot.consoles ?? []).map(c=>c.handle), store.snapshot.console?.handle].filter(Boolean))].sort().map(handle => ({
        handle, live: [...(store.snapshot.consoles ?? []), ...(store.snapshot.console ? [store.snapshot.console] : [])].some(c => c.handle === handle && deps.nowS() - c.heartbeatAt <= LIMITS.heartbeatS),
      })), autoConsoleOutcome: hintKey(), strategies: store.snapshot.strategies, transport: store.transport, reachable,
    });
    const logError = (e: unknown) => ctx.log(`pacer: ${e instanceof Error ? e.message : String(e)}`);
    const scheduleRender = (immediate=false) => {
      if(immediate){userOutcome=true;cancelRender?.();cancelRender=null;}
      if (stopped || cancelRender) return;
      cancelRender = timers.after(Math.max(200, (lastRenderAt+(userOutcome?2:10)-deps.nowS())*1000), () => {
        cancelRender = null;
        if (stopped) return;
        try {
          const key = panelKey(), nowS = deps.nowS();
          if (key !== renderedKey) {
            if (pluginMode(deps.pluginRoot, deps.fs) === "live") {
              deps.fs.writeTextAtomic(join(deps.pluginRoot, "panel", "live.html"), renderPanel(store.snapshot, { nowS, transport: store.transport, reachable, lastSeenAt, autoConsole: settings.autoConsole, notifications:settings.notifications, autoConsoleOutcome: panelOutcome(), bootstrap: deps.bootstrap?.state, updates: panelUpdates() }));
              renderedKey = key; lastRenderAt=nowS; userOutcome=false;
            } else ctx.log("pacer: refused panel write: unmanaged root");
          }
        } catch (e) { logError(e); }
        const snapshot = store.snapshot;
        processing = processing.then(async () => { if (!stopped) await notifyNewAlerts(ctx.host, snapshot, settings, activatedAtS, deps.nowS()); }).catch(logError);
      });
    };
    if (deps.bootstrap) {
      void deps.bootstrap.activate(ctx).then(() => deps.bootstrap!.run(ctx, () => scheduleRender(true))).catch(logError);
      timers.every(60000, () => { if (!stopped) void deps.bootstrap!.run(ctx, () => scheduleRender(true)).catch(logError); });
      timers.every(5000, () => { if (!stopped) void deps.bootstrap!.refreshAgents(ctx, () => scheduleRender(true)).catch(logError); });
    }
    // Only the worker may read host settings; refresh preferences without restarting.
    let refreshingSettings=false;
    timers.every(30000,()=>{
      if(stopped || refreshingSettings)return;
      refreshingSettings=true;
      void ctx.host.call("settings.get").then(result=>{
        if(stopped)return;
        const updated=readSettings(result.settings,deps.home),changed=settings.notifications!==updated.notifications;
        settings.lastAlertAt=Math.max(settings.lastAlertAt,updated.lastAlertAt);
        settings.deliveredAlerts=[...(settings.deliveredAlerts??[]),...(updated.deliveredAlerts??[])].slice(-200);
        settings.notifications=updated.notifications;
        settings.settingsReady=true;
        if(changed)scheduleRender(true);
      }).catch(()=>{}).finally(()=>{refreshingSettings=false;});
    });
    store.onChange(()=>scheduleRender());
    timers.every(1000,()=>{processing=processing.then(async()=>{if(!stopped)await notifyNewAlerts(ctx.host,store.snapshot,settings,activatedAtS,deps.nowS());}).catch(logError);});
    timers.every(15000, () => { if (panelKey() !== renderedKey) scheduleRender(); });
    const replaceSnapshot = (snapshot: Parameters<LinkStore["replace"]>[0]) => {
      if (stopped) return;
      const previous=store.snapshot;
      const consoleChanged=!!snapshot.console?.handle!==!!previous.console?.handle;
      const initiated=consoleChanged||snapshot.budget?.strategy!==previous.budget?.strategy || snapshot.tasks.some(t=>!previous.tasks.some(p=>p.id===t.id)||t.dismissed!==previous.tasks.find(p=>p.id===t.id)?.dismissed||t.retriedBy!==previous.tasks.find(p=>p.id===t.id)?.retriedBy) || snapshot.alerts.some(a=>a.key==="strategy-build"&&!previous.alerts.some(p=>p.key===a.key&&p.at===a.at)) || snapshot.budget?.providers.some(p=>p.blockedReason!==previous.budget?.providers.find(x=>x.id===p.id)?.blockedReason);
      if(initiated){userOutcome=true;if(cancelRender){cancelRender();cancelRender=null;}}
      store.replace(snapshot);
    };
    const acceptSnapshot = (snapshot: Parameters<LinkStore["replace"]>[0]) => {
      if (stopped) return;
      httpFailures = 0;
      lastSeenAt = deps.nowS();
      if (!reachable) { reachable = true; scheduleRender(true); }
      replaceSnapshot(snapshot);
    };
    const connect = async () => {
      const chosen = await chooseTransport(transports, settings.transport);
      if (stopped) return;
      active = chosen.transport; reachable = chosen.reachable && active?.id !== "bridge";
      if (reachable) lastSeenAt = deps.nowS(); store.transport = active?.id ?? null;
      if (!active) {
        scheduleRender();
        cancelRetry = timers.after(settings.pollSeconds * 1000, () => { cancelRetry = null; void ensureConnected(); });
        return;
      }
      const snapshot = await active.snapshot().catch(() => null) ?? await bridge.snapshot();
      if (stopped) return;
      if (snapshot) replaceSnapshot(snapshot);
      stopWatch = active.watch(e => { if (!stopped) { lastSeenAt = deps.nowS(); store.apply(e); } }, active.id === "bridge" ? replaceSnapshot : acceptSnapshot, () => { void handleHttpFailure().catch(logError); });
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
      try { if(settings.notifications!=="all")return;const plain=title.startsWith("pacer ")&&!title.includes("console")?"Budget refreshed":title.replace(/\bpacer\b\s*/gi,"");await deliverNotification(ctx.host, { title: clip(plain, 60), body:body?.startsWith("terminal ")?"Nothing to do.":title.startsWith("pacer ")&&!title.includes("console")?"Open the pacer panel for the current budget.":clip(body??"Nothing to do.",1000) },deps.nowS()); } catch (e) { logError(e); }
    };
    const handleHttpFailure = async () => {
      const failures = ++httpFailures;
      const snapshot = await bridge.snapshot();
      if (snapshot) replaceSnapshot(snapshot);
      if (stopped || active?.id !== "http") return;
      reachable = false;
      if (lastSeenAt !== undefined) timers.after(Math.max(0, (20 - (deps.nowS()-lastSeenAt))*1000), scheduleRender);
      if (failures >= 3) {
        stopWatch?.(); stopWatch = null; httpFailures = 0;
        await ensureConnected();
      }
      scheduleRender();
    };
    const refreshSnapshot = async () => {
      try {
        const snapshot = await active?.snapshot().catch(() => null);
        if (snapshot) { if (active?.id === "bridge") replaceSnapshot(snapshot); else acceptSnapshot(snapshot); }
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
        if (focusedWorktree !== worktree) { focusedWorktree = worktree; attempted = false; outcomes.delete(worktree); scheduleRender(true); }
        const now = deps.nowS(), ids = new Set(context.terminals.map(t => t.id));
        if ([...(store.snapshot.consoles ?? []), ...(store.snapshot.console ? [store.snapshot.console] : [])].some(c => c.handle && ids.has(c.handle) && now - c.heartbeatAt <= LIMITS.heartbeatS)) {
          if (outcomes.get(worktree)?.status !== "registered") { outcomes.set(worktree, { status: "registered", at: now }); scheduleRender(true); } return;
        }
        if (attempted) {
          const outcome = outcomes.get(worktree);
          if (outcome?.status === "registered" || (outcome?.status === "starting" && now-outcome.at >= 30)) {
            outcomes.set(worktree, { status: "gave-up", at: now }); scheduleRender(true);
          }
          return;
        }
        attempted = true; outcomes.set(worktree, { status: "starting", at: now }); scheduleRender(true);
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
          outcomes.set(worktree, { status: typeof result.reason === "string" ? result.reason : "orca-unavailable", at: deps.nowS() }); scheduleRender(true);
        } else if (result.warning === "older-console") { outcomes.set(worktree, { status: "older-console", at: deps.nowS() }); scheduleRender(true); } else if (response.status !== 200 && !(response.status === 202 && result.queued === true)) throw new Error(`HTTP ${response.status}`);
      })().catch(e => {
        const now = deps.nowS();
        outcomes.set(worktree, { status: "orca-unavailable", at: now }); scheduleRender(true);
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
      await new Promise(resolve=>setTimeout(resolve,1000));
      await refreshSnapshot();
      await sendToConsole(ctx.host, store.snapshot, { cmd: "agent-done", paneKey: p.paneKey, ...(typeof p.worktreeId === "string" ? { worktreeId: p.worktreeId } : {}) }, now);
    });
    ctx.events.on("worktree.created", async payload => {
      await ensureConnected();
      if (!payload || typeof payload !== "object") return;
      const p = payload as WorktreeCreated;
      if (typeof p.branch !== "string" || !/(^|\/)pacer-/.test(p.branch) || typeof p.worktreeId !== "string" || typeof p.path !== "string") return;
      await new Promise(resolve=>setTimeout(resolve,1000));
      await sendFresh({ cmd: "worktree-created", worktreeId: p.worktreeId, path: p.path, branch: p.branch });
    });
    ctx.events.on("worktree.removed", async payload => {
      if (stopped || !payload || typeof payload !== "object" || !("worktreeId" in payload)) return;
      const id = payload.worktreeId;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}(?:::[^\x00-\x1f\x7f]{1,900})?$/.test(id)) return;
      outcomes.delete(id); failureLogged.delete(id);
      if (focusedWorktree === id) { focusedWorktree = null; attempted = false; }
      scheduleRender();
      try {
        const base = `http://127.0.0.1:${settings.port}`;
        const health = await deps.http.get(`${base}/health`, "", 1500);
        if (stopped || health.status !== 200 || health.headers?.["x-pacer"] !== "1") return;
        const token = deps.fs.readText(`${settings.pacerHome}/token`)?.trim();
        if (!token || !deps.http.post) return;
        await deps.http.post(`${base}/console/forget`, token, { worktreeId: id }, 1500);
      } catch (e) { logError(e); }
    });
    try { void ctx.host.call("events.subscribe", { events: ["agent.status.changed", "worktree.created", "worktree.removed"] }).catch(logError); }
    catch (e) { logError(e); }
    void ensureConnected();
  }
  return {
    activate,
    async deactivate() {
      stopped = true; deps.bootstrap?.stop(); stopWatch?.(); stopWatch = null; cancelRender?.(); cancelRender = null; cancelRetry?.(); cancelRetry = null;
      for (const cancel of timerCancels) cancel(); timerCancels.clear();
    },
  };
}
