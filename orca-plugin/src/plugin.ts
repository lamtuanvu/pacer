import { createHash } from "node:crypto";
import type { SetupChecklist } from "../../src/setup/checklist";
import { notifyUpdates, UPDATE_INTERVAL_MS, type PluginUpdates } from "./updates";
import { updateAvailable, type UpdateCheck } from "../../src/update/check";
import { pluginMode } from "./mode";
import type { Bootstrap } from "./bootstrap";
import { join } from "node:path";
import type { OrcaWorkerContext } from "./orca-api";
import { readSettings } from "./settings";
import { LinkStore } from "./store";
import { chooseTransport, type Transport } from "./transports/choose";
import type { ApiClient } from "../../src/api/client-types";
import { apiTransport } from "./transports/api";
import { httpTransport, type HttpPort } from "./transports/http";
import { bridgeTransport } from "./transports/bridge";
import { channelTransport } from "./transports/channel";
import { notifyNewAlerts } from "./notify";
import { renderStatusPage } from "./panel";
export interface Timers { every(ms: number, fn: () => void): () => void; after(ms: number, fn: () => void): () => void }
export interface PluginDeps {
  connect?(settings: { port: number; pacerHome: string }): Promise<ApiClient | null>;
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
  const clients = new Set<ApiClient>();
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
    ctx.commands.register("open", async () => {
      await ctx.host.call("notifications.show", {
        title: "Open pacer",
        body: "Run `pacer dashboard` in a terminal. The pacer app opens from here once it ships.",
      });
      return { ok: true };
    });
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
        timers.every(30000, () => { void run().catch(logError); });
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
      apiTransport({ timers, log: m => ctx.log(m), connect: async () => {
        const client = await deps.connect?.(settings) ?? null;
        if (stopped) { client?.close(); return null; }
        if (client && !clients.has(client)) {
          const close = client.close.bind(client);
          client.close = () => { try { close(); } finally { clients.delete(client); } };
          clients.add(client);
        }
        return client;
      } }),
      httpTransport({ http: deps.http, readToken: () => deps.fs.readText(`${settings.pacerHome}/token`)?.trim() || null, port: settings.port, timers }),
      channelTransport({ host: ctx.host, registerEvent: (name, handler) => ctx.events.on(name, async payload => { await ensureConnected(); if (!stopped) handler(payload); }) }),
      bridge,
    ];
    let active: Transport | null = null, reachable = false, connecting: Promise<void> | null = null;
    let lastSeenAt: number | undefined;
    let processing = Promise.resolve();
    let httpFailures = 0;
    let setup:SetupChecklist|undefined;
    let renderedKey: string | null = null;
    let lastRenderAt=-Infinity;
    let userOutcome=false;
    const panelUpdates = (): PluginUpdates | undefined => {
      if (!deps.version) return updates;
      const cached = deps.cachedUpdate?.();
      const latest = cached?.latest ?? updates?.latest ?? null;
      const cli = store.snapshot.console?.version ?? updates?.cli ?? null;
      const check = { checkedAt: deps.nowS(), latest, current: deps.version };
      return { plugin: deps.version, cli, latest, available: updateAvailable(check) || (!!cli && updateAvailable({...check,current:cli})) };
    };
    const logError = (e: unknown) => ctx.log(`pacer: ${e instanceof Error ? e.message : String(e)}`);
    const scheduleRender = (immediate=false) => {
      if(immediate){userOutcome=true;cancelRender?.();cancelRender=null;}
      if (stopped || cancelRender) return;
      cancelRender = timers.after(Math.max(200, (lastRenderAt+(userOutcome?2:10)-deps.nowS())*1000), () => {
        cancelRender = null;
        if (stopped) return;
        try {
          const nowS = deps.nowS();
          const html = renderStatusPage(store.snapshot, { nowS, transport: store.transport, reachable, setup, bootstrap: deps.bootstrap?.state, updates: panelUpdates() });
          const key = createHash("sha1").update(html).digest("hex");
          if (key !== renderedKey) {
            if (pluginMode(deps.pluginRoot, deps.fs) === "live") {
              deps.fs.writeTextAtomic(join(deps.pluginRoot, "panel", "live.html"), html);
              renderedKey = key; lastRenderAt=nowS; userOutcome=false;
            } else ctx.log("pacer: refused panel write: unmanaged root");
          }
        } catch (e) { logError(e); }
        const snapshot = store.snapshot;
        processing = processing.then(async () => { if (!stopped) await notifyNewAlerts(ctx.host, snapshot, settings, activatedAtS, deps.nowS()); }).catch(logError);
      });
    };
    if (deps.bootstrap) {
      let checking=false, nextCheckAt=0, request:string|null=null;
      const checkSetup = async () => {
        const latest=deps.fs.readText(join(settings.pacerHome,"check-setup-request.json"));
        if(latest!==request){request=latest;nextCheckAt=0;}
        if(stopped || checking || deps.nowS()<nextCheckAt)return;
        checking=true;
        try {
          const result=await deps.bootstrap!.checkSetup(reachable,settings.pacerHome);
          if(stopped)return;
          setup=result;nextCheckAt=deps.nowS()+(result.complete?60:5);scheduleRender(true);
        }catch(e){logError(e);}finally{checking=false;}
      };
      void checkSetup();
      timers.every(5000,()=>{void checkSetup();});
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
    timers.every(15000, () => { scheduleRender(); });
    const replaceSnapshot = (snapshot: Parameters<LinkStore["replace"]>[0]) => {
      if (stopped) return;
      const previous=store.snapshot;
      const initiated=snapshot.budget?.strategy!==previous.budget?.strategy || snapshot.tasks.some(t=>!previous.tasks.some(p=>p.id===t.id)||t.dismissed!==previous.tasks.find(p=>p.id===t.id)?.dismissed||t.retriedBy!==previous.tasks.find(p=>p.id===t.id)?.retriedBy) || snapshot.alerts.some(a=>a.key==="strategy-build"&&!previous.alerts.some(p=>p.key===a.key&&p.at===a.at)) || snapshot.budget?.providers.some(p=>p.blockedReason!==previous.budget?.providers.find(x=>x.id===p.id)?.blockedReason);
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
      if (stopped || probing || connecting || active?.id === "http" || active?.id === "api") return;
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
    void ensureConnected();
  }
  return {
    activate,
    async deactivate() {
      stopped = true; deps.bootstrap?.stop(); stopWatch?.(); stopWatch = null; cancelRender?.(); cancelRender = null; cancelRetry?.(); cancelRetry = null;
      for (const client of clients) client.close(); clients.clear();
      for (const cancel of timerCancels) cancel(); timerCancels.clear();
    },
  };
}
