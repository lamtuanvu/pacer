import { configuredNativeServices } from "../update/desktop/native-provider";
import { bindDesktopUpdateRuntime, createDesktopUpdateRuntime } from "../update/desktop/service";
import { reconcileAdmissionSync } from "../update/desktop/admission";
import { retentionScheduler } from "../tasks/retention";
import { superviseTasks } from "../tasks/api";
import { startHealthListener } from "./health-listener";
import { createReadCache } from "./read-cache";
import { liveSnapshot } from "../api/events";
import { recoverJobs, registerJobDaemon } from "../jobs/registry";
import { sessionWebSocket, upgradeSession, type SessionWS } from "./session-ws";
import { randomBytes } from "node:crypto";
import { checkSession, safeEqual } from "./app-auth";
import { appPage, appRoute } from "./app-routes";
import { handleV2 } from "../api/http";
import type { OpDeps } from "../api/ops";
import { existsSync, mkdirSync, readFileSync, writeFileSync, watch } from "node:fs";
import { join } from "node:path";
import { loadStrategy } from "../config/strategy";
import { computeStatus, type Status } from "../engine/status";
import type { Ctx } from "../types";
import { currentSnapshot, invalidateConsoleCache, refreshConsoleTerminals } from "../link/store";
import { defaultPumpDeps, pumpOnce } from "../link/pump";


import { DEFAULT_PORT } from "./constants";
export { DEFAULT_PORT } from "./constants";
/** How long a request waits for the first status before the snapshot answers as starting. */
export const STATUS_WARMUP_WAIT_MS = 300;

export function ensureToken(ctx: Ctx): string {
  const p = join(ctx.pacerHome, "token");
  if (existsSync(p)) {
    const t = readFileSync(p, "utf8").trim();
    if (t) return t;
  }
  mkdirSync(ctx.pacerHome, { recursive: true });
  const t = randomBytes(24).toString("hex");
  writeFileSync(p, `${t}\n`, { mode: 0o600 });
  return t;
}

/** Localhost-only, token-protected API for versioned client protocols. */
export function startServer(
  getCtx: () => Ctx, opts: { port?: number; listener?: false; sseIntervalMs?: number; tailMs?: number; pumpMs?: number; opDeps?: OpDeps } = {},
): { port: number; token: string; stop: () => void } {
  const initialCtx = getCtx();
  const token = ensureToken(initialCtx);
  reconcileAdmissionSync(initialCtx);
  recoverJobs(initialCtx);
  const nativeServices = opts.opDeps?.desktopUpdates ? null : configuredNativeServices(getCtx,opts.port??Number(initialCtx.env.PACER_PORT??DEFAULT_PORT),()=>{
    stop();setImmediate(()=>process.exit(0));
  });
  nativeServices?.native.listen();
  const desktopUpdates = opts.opDeps?.desktopUpdates ?? createDesktopUpdateRuntime(getCtx,nativeServices??{});
  const unbindDesktopUpdates = bindDesktopUpdateRuntime(initialCtx, desktopUpdates);
  const tailMs = opts.tailMs ?? 1_000;
  const pumpMs = opts.pumpMs ?? 15_000;
  let snapshot = currentSnapshot(initialCtx);
  let cachedStatus: Status | null = null;
  let statusError: string | null = null;
  let statusPending: Promise<void> | null = null;
  let stopped = false;
  let listener: ReturnType<typeof startHealthListener> | undefined;
  const refreshStatus = () => {
    if(statusPending || stopped)return;
    statusPending = Promise.resolve().then(async()=>{
      const ctx=getCtx();
      const next=await computeStatus(ctx,loadStrategy(ctx));
      if (!stopped) {
        cachedStatus = next; statusError = null;
      }
    }).catch(e=>{if(!stopped)statusError=e instanceof Error?e.message:String(e);}).finally(()=>{statusPending=null;});
  };
  const status = async () => {
    // A cold start rebuilds the activity profile from agent logs, which can take seconds.
    // Wait briefly for it, then let callers answer as "starting" instead of hanging.
    if (!cachedStatus && statusPending) await Promise.race([statusPending, Bun.sleep(STATUS_WARMUP_WAIT_MS)]);
    if (!cachedStatus && statusError) throw Error(statusError);
    if(!cachedStatus)throw Error("status is warming up");
    return cachedStatus;
  };
  const readCache = createReadCache(async () => {
    const value = await liveSnapshot(getCtx(), { status });
    return value;
  }, 1000);
  let publicPort = opts.port ?? DEFAULT_PORT;
  const refreshSnapshot = () => {
    if(stopped)return;
    try{const ctx=getCtx();snapshot=currentSnapshot(ctx);}catch{ /* Preserve last known data. */ }
  };
  // File notifications update memory outside request handlers; the timer covers missed notifications.
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const scheduleSnapshot=()=>{if(scheduled || stopped)return;scheduled=setTimeout(()=>{scheduled=undefined;refreshSnapshot();},0);};
  const watchers:ReturnType<typeof watch>[]=[];
  for(const dir of [initialCtx.pacerHome,join(initialCtx.pacerHome,"link"),join(initialCtx.pacerHome,"link","consoles")]) {
    mkdirSync(dir,{recursive:true});
    try{watchers.push(watch(dir,()=>{invalidateConsoleCache(initialCtx);scheduleSnapshot();}));}catch{}
  }
  refreshStatus();
  let server: ReturnType<typeof Bun.serve<SessionWS>>;
  try { server = Bun.serve<SessionWS>({
    websocket: sessionWebSocket,
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req, server) {
      const { pathname } = new URL(req.url);
      const sessionRoute=pathname.match(/^\/v[23]\/tasks\/([A-Za-z0-9_-]+)\/session$/);
      const hosts = [`127.0.0.1:${publicPort}`, `localhost:${publicPort}`];
      if (!hosts.includes(req.headers.get("host") ?? "")) return new Response("misdirected request\n", { status: 421 });
      if (req.method === "OPTIONS") return pathname.startsWith("/app/") ? appPage("Method not allowed.", 405) : new Response("method not allowed\n", { status: 405 });
      const headers = { "X-Pacer": "1" };
      if (req.method === "GET" && pathname === "/health") return Response.json({ ok: true, pid: process.pid }, { headers });
      if (pathname === "/app/auth") return appRoute(req, getCtx());
      const app = pathname.startsWith("/app/");
      const bearer = safeEqual(req.headers.get("authorization") ?? "", `Bearer ${token}`);
      if (!bearer) {
        const value = (req.headers.get("cookie") ?? "").split(";").map(c => c.trim()).find(c => c.startsWith("pacer_session="))?.slice("pacer_session=".length);
        if (!(app || /^\/v[23]\//.test(pathname)) || !value || !checkSession(getCtx(), value)) {
          return app ? appPage("Session ended. Run `pacer open`.", 401) : new Response("unauthorized\n", { status: 401 });
        }
        if (/^\/v[23]\/session\/exchange$/.test(pathname)) return new Response("forbidden\n", { status: 403 });
        const site = req.headers.get("sec-fetch-site");
        if ((sessionRoute && !hosts.map(host => `http://${host}`).includes(req.headers.get("origin") ?? "")) || (site !== null && !["same-origin", "none"].includes(site)) ||
            (!["GET", "HEAD"].includes(req.method) &&
             (!hosts.map(host => `http://${host}`).includes(req.headers.get("origin") ?? "") || req.headers.get("x-pacer-client") !== "app"))) {
          return app ? appPage("Forbidden.", 403) : new Response("forbidden\n", { status: 403 });
        }
      }
      if (app) return appRoute(req, getCtx());
      if (sessionRoute) return upgradeSession(req, server, getCtx(), sessionRoute[1]!);
      if (/^\/v[23]\//.test(pathname)) {
        const response=await handleV2(req, { getCtx, opDeps: {...opts.opDeps, snapshotProbe:false, terminalPresetsOnly: !bearer}, tailMs, status, snapshot: () => readCache.get() });
        response.headers.set("X-Pacer","1");
        return response;
      }
      if(pathname==="/state"||pathname.startsWith("/console/"))return new Response("not found\n",{status:404});
      if (req.method !== "GET") return new Response("method not allowed\n", { status: 405 });
      return new Response("not found\n", { status: 404 });
    },
  }); } catch (error) {
    stopped = true; nativeServices?.native.stop(); unbindDesktopUpdates(); clearTimeout(scheduled);
    for (const watcher of watchers) watcher.close();
    throw error;
  }
  try {
    // Handler tests can explicitly skip the public listener and use the backend.
    if (opts.listener === false) {
      publicPort = server.port!;
    } else {
      listener = startHealthListener(server.port!, publicPort);
      publicPort = listener.port;
    }
  } catch (error) {
    stopped = true; nativeServices?.native.stop(); unbindDesktopUpdates(); clearTimeout(scheduled);
    readCache.stop();
    for (const watcher of watchers) watcher.close();
    server.stop(true);
    throw error;
  }
  void desktopUpdates.start().catch(() => { console.error("pacer: desktop update startup requires recovery"); });
  const unregisterJobs = registerJobDaemon(initialCtx);
  refreshSnapshot();
  let busy = false;
  const tick = () => {
    if (busy || stopped) return;
    busy = true;
    void Promise.resolve().then(async () => {
      if(stopped)return;
      const ctx = getCtx();
      await refreshConsoleTerminals(ctx);
      if(!cachedStatus){refreshStatus(); await statusPending;}
      if(stopped)return;
      return pumpOnce(ctx,{
        ...defaultPumpDeps,status,
        // A tick can still be awaiting repo or setup probes when stop() runs.
        publish:(c,envs)=>stopped
          ? Promise.resolve({seq:0,transports:[],errors:["service stopped"]})
          : defaultPumpDeps.publish(c,envs),
      });
    }).catch(() => []).finally(() => { busy = false; refreshSnapshot(); });
  };
  const retention = retentionScheduler();
  const prune = () => {
    if (!stopped) void retention.tick(getCtx()).catch(error => console.warn(`pacer: task retention failed: ${String(error)}`));
  };
  const retentionStart = setTimeout(prune, 0);
  const retentionTimer = setInterval(prune, 60_000);
  let supervising = false;
  const supervise = () => {
    if (stopped || supervising) return;
    supervising = true;
    void superviseTasks(getCtx(), opts.opDeps?.spawnRunner, () => stopped)
      .catch(error => { if (!stopped) console.error(`pacer: task supervision failed: ${String(error)}`); })
      .finally(() => { supervising = false; });
  };
  const supervisorTimer = setInterval(supervise, 5000);
  const snapshotTimer=setInterval(refreshSnapshot,2000);
  const statusTimer=setInterval(refreshStatus,60000);
  const terminalTimer=setInterval(()=>{if(!stopped)void Promise.resolve().then(()=>refreshConsoleTerminals(getCtx())).catch(()=>{});},10000);
  const pumpTimer = pumpMs > 0 ? setInterval(tick, pumpMs) : undefined;
  return { port: publicPort, token, stop: () => { nativeServices?.native.stop(); desktopUpdates.stop(); unbindDesktopUpdates(); listener?.stop(); readCache.stop(); unregisterJobs(); stopped=true; clearTimeout(retentionStart); clearInterval(retentionTimer); clearInterval(supervisorTimer); clearInterval(pumpTimer); clearInterval(snapshotTimer); clearInterval(statusTimer); clearInterval(terminalTimer); clearTimeout(scheduled); for(const watcher of watchers)watcher.close(); server.stop(true); } };
}
