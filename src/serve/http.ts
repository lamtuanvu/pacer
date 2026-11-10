import { autoCleanSweep } from "../core/tasks";
import { pluginNativeRoute } from "./plugin-native";
import { startTaskHistory } from "../tasks/history";
import { refreshConnectedIntegrations } from "../core/integrations";
import { authorizeWorkGrant } from "../dispatch/work";
import { authorizeEnforcementToken } from "../dispatch/enforcement-token";
import { refreshObservations } from "../dispatch/refresh";
import { desktopCaptureRoute } from "./desktop-capture";
import { attachmentRoute } from "./attachment-routes";
import { resetCaptureBroker } from "../desktop/capture-broker";
import { configuredNativeServices } from "../update/desktop/native-provider";
import type { PairedNativeBootstrap } from "../update/desktop/native-paired-bootstrap";
import { bindDesktopUpdateRuntime, createDesktopUpdateRuntime } from "../update/desktop/service";
import { reconcileAdmissionSync } from "../update/desktop/admission";
import { selfCommand, superviseTasks } from "../tasks/api";
import type { SpawnRunner } from "../tasks/api";
import { reconcileTaskJson } from "../tasks/store";
import { startHealthListener } from "./health-listener";
import { createReadCache } from "./read-cache";
import { liveSnapshot } from "../api/events";
import { shutdownPlugins } from "../plugins";
import { triggerHandover } from "../tasks/handover-service";
import { recoverFixtureHandover } from "../service/upgrade";
import { compiledNativeFixture } from "../update/desktop/native-fixture";
import { recoverJobs, registerJobDaemon } from "../jobs/registry";
import { sessionWebSocket, upgradeSession, upgradeTerminal, upgradeAgentSession, type SessionWS } from "./session-ws";
import { isExecutorSession } from "../install/role";
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
import { currentSnapshot, invalidateConsoleCache, notifyOutbox, refreshConsoleTerminals } from "../link/store";
import { refreshAllUsage } from "../usage/refresh";
import { defaultPumpDeps, pumpOnce } from "../link/pump";
import { tick as certificationTick } from "../dispatch/certification-schedule";
import { brokerTick } from "../messaging/broker";

import { DEFAULT_PORT } from "./constants";
import { writeJsonAtomic } from "../fsutil";
import { backgroundWorkerEntryURL } from "./worker-location";
export { DEFAULT_PORT } from "./constants";
/** How long a request waits for the first status before the snapshot answers as starting. */
export const STATUS_WARMUP_WAIT_MS = 300;
/** Upper bound for one batch of LAN observations from the radio. */
const DISCOVERY_BODY_MAX = 256 * 1024;

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
  getCtx: () => Ctx, opts: { internal?: { token: string }; pairedNative?: PairedNativeBootstrap; port?: number; supervisionWorker?: boolean; backgroundWorker?: boolean; listener?: false; sseIntervalMs?: number; tailMs?: number; pumpMs?: number; opDeps?: OpDeps; bgMonitorMs?: number; bgSilenceTicks?: number; bgStopGraceMs?: number; bgHeartbeatMs?: number; bgUsageMs?: number } = {},
): { port: number; token: string; backgroundWorker: () => Worker | undefined; stop: () => Promise<void> } {
  const initialCtx = getCtx();
  const bg = !!opts.backgroundWorker;
  resetCaptureBroker(initialCtx.pacerHome);
  const token = ensureToken(initialCtx);
  reconcileAdmissionSync(initialCtx);
  recoverJobs(initialCtx, undefined, async () => recoverFixtureHandover(initialCtx.pacerHome, compiledNativeFixture(),
    async () => (await triggerHandover({ ...getCtx(), now: Date.now() / 1000 })).summary));
  // Serving diagnostics must not wait on account configuration writes. New local
  // launches serialize with this job through the shared installation lock.
  void Promise.resolve().then(() => refreshConnectedIntegrations(initialCtx)).then(results => {
    for (const result of results) if (result.state === "conflict" || result.state === "failed")
      console.error(`pacer: integration ${result.target}: ${result.detail}. ${result.hint}`);
  }).catch(() => console.error("pacer: integration refresh failed; run pacer doctor for recovery guidance"));
  const nativeServices = opts.opDeps?.desktopUpdates ? null : configuredNativeServices(getCtx,opts.port??Number(initialCtx.env.PACER_PORT??DEFAULT_PORT),opts.pairedNative?.shutdown ?? (()=>{

    stop();setImmediate(()=>process.exit(0));
  }), opts.pairedNative);
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
  // Periodic loops owned by the background worker; left undefined when it runs them.
  let cleanStart: ReturnType<typeof setTimeout> | undefined;
  let cleanTimer: ReturnType<typeof setInterval> | undefined;
  let certificationTimer: ReturnType<typeof setInterval> | undefined;
  let brokerTimer: ReturnType<typeof setInterval> | undefined;
  let usageStart: ReturnType<typeof setTimeout> | undefined;
  let usageTimer: ReturnType<typeof setInterval> | undefined;
  let pumpTimer: ReturnType<typeof setInterval> | undefined;
  let observationTimer: ReturnType<typeof setInterval> | undefined;
  const refreshStatus = () => {
    if(statusPending || stopped)return statusPending;
    statusPending = Promise.resolve().then(async()=>{
      const ctx=getCtx();
      const next=await computeStatus(ctx,loadStrategy(ctx));
      if (!stopped) {
        cachedStatus = next; statusError = null;
      }
    }).catch(e=>{if(!stopped)statusError=e instanceof Error?e.message:String(e);}).finally(()=>{statusPending=null;});
    return statusPending;
  };
  const refreshStatusAfterPending = async () => {
    if (statusPending) await statusPending;
    await refreshStatus();
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
      const agentSessionRoute=pathname.match(/^\/v3\/tasks\/([A-Za-z0-9_-]+)\/agent-sessions\/([0-9a-f-]{36})\/session$/);
      const terminalRoute=pathname.match(/^\/v3\/terminals\/([0-9a-f-]{36})\/session$/);
      const hosts = [`127.0.0.1:${publicPort}`, `localhost:${publicPort}`];
      if (!hosts.includes(req.headers.get("host") ?? "")) return new Response("misdirected request\n", { status: 421 });
      const app = pathname.startsWith("/app/");
      let bearer: boolean;
      let workGrant: string | undefined;
      let enforcementToken: string | undefined;
      if (opts.internal) {
        if (!safeEqual(req.headers.get("authorization") ?? "", `Bearer ${opts.internal.token}`)) {
          return new Response("unauthorized\n", { status: 401 });
        }
        const authKind = req.headers.get("x-pacer-auth") ?? "bearer";
        if (authKind !== "bearer" && authKind !== "cookie" && authKind !== "task") return new Response("forbidden\n", { status: 403 });
        bearer = authKind === "bearer";
        if (authKind === "task") {
          const forwarded = req.headers.get("x-pacer-work-grant") ?? "";
          const scoped = forwarded.startsWith("Bearer ") ? forwarded.slice(7) : undefined;
          if (!scoped || req.method !== "POST" || !pathname.startsWith("/v3/ops/")) return new Response("forbidden\n", { status: 403 });
          if(scoped.startsWith("pet_"))enforcementToken=scoped;else workGrant=scoped;
        }
        // The front door's heartbeat: an answer proves this event loop is responsive.
        if (req.method === "GET" && pathname === "/health") return Response.json({ ok: true, pid: process.pid });
        if (pathname === "/_internal/plugins") return pluginNativeRoute(getCtx(), req);
        if (pathname === "/_internal/app-page") {
          const params = new URL(req.url).searchParams;
          const status = Number(params.get("status") ?? 200);
          return appPage(params.get("message") ?? "", Number.isInteger(status) && status >= 200 && status <= 599 ? status : 500);
        }
        if (pathname === "/_internal/native-config-finish" && req.method === "POST") {
          if (authKind !== "bearer") return new Response("forbidden\n", {status: 403});
          try {
            const {finishNativeConfigEdit} = await import("../core/accounts");
            const body = await req.json();
            await finishNativeConfigEdit(getCtx(), body?.op);
            return Response.json({result: null});
          } catch (error) {
            const {toApiError, httpStatus} = await import("../api/errors");
            const body = toApiError(error);
            return Response.json({error: body}, {status: httpStatus(body.code)});
          }
        }
        if (pathname === "/_internal/status-broker-parts" && req.method === "POST") {
          if (authKind !== "bearer") return new Response("forbidden\n", { status: 403 });
          try {
            const { computeStatus } = await import("../engine/status");
            const { loadStrategy } = await import("../config/strategy");
            const ctx = getCtx();
            const status = await computeStatus(ctx, loadStrategy(ctx));
            return Response.json({ result: { accounts: status.accounts, providers: status.providers } });
          } catch (error) {
            const { toApiError, httpStatus } = await import("../api/errors");
            const body = toApiError(error);
            return Response.json({ error: body }, { status: httpStatus(body.code) });
          }
        }
        if (pathname === "/_internal/session-probe-parts" && req.method === "POST") {
          if (authKind !== "bearer") return new Response("forbidden\n", { status: 403 });
          try {
            const { sessionProbeParts } = await import("../api/session-probe-bridge");
            return Response.json({ result: sessionProbeParts(getCtx()) });
          } catch (error) {
            const { toApiError, httpStatus } = await import("../api/errors");
            const body = toApiError(error);
            return Response.json({ error: body }, { status: httpStatus(body.code) });
          }
        }
        if (pathname === "/_internal/config-host-parts" && req.method === "POST") {
          if (authKind !== "bearer") return new Response("forbidden\n", { status: 403 });
          try {
            const { configHostParts } = await import("../api/config-host-bridge");
            return Response.json({ result: configHostParts(getCtx()) });
          } catch (error) {
            const { toApiError, httpStatus } = await import("../api/errors");
            const body = toApiError(error);
            return Response.json({ error: body }, { status: httpStatus(body.code) });
          }
        }
        if (pathname === "/_internal/host-read-parts" && req.method === "POST") {
          if (authKind !== "bearer") return new Response("forbidden\n", { status: 403 });
          try {
            const body = await req.json().catch(() => ({}));
            const alias = body && typeof body === "object" && !Array.isArray(body)
              ? (body as { alias?: unknown }).alias
              : undefined;
            const { hostReadParts, hostReadDetailParts } = await import("../api/host-read-bridge");
            const result = typeof alias === "string" && alias
              ? await hostReadDetailParts(getCtx(), alias)
              : hostReadParts(getCtx());
            return Response.json({ result });
          } catch (error) {
            const { toApiError, httpStatus } = await import("../api/errors");
            const body = toApiError(error);
            return Response.json({ error: body }, { status: httpStatus(body.code) });
          }
        }
        if (pathname === "/_internal/task-read-parts" && req.method === "POST") {
          if (authKind !== "bearer") return new Response("forbidden\n", { status: 403 });
          try {
            const body = await req.json().catch(() => null);
            const id = body && typeof body === "object" && !Array.isArray(body) ? (body as { id?: unknown }).id : undefined;
            if (typeof id !== "string" || !id) {
              const { CoreError } = await import("../core/errors");
              throw new CoreError("invalid_input", "id required");
            }
            const { taskReadParts } = await import("../api/task-read-bridge");
            return Response.json({ result: await taskReadParts(getCtx(), id) });
          } catch (error) {
            const { toApiError, httpStatus } = await import("../api/errors");
            const body = toApiError(error);
            return Response.json({ error: body }, { status: httpStatus(body.code) });
          }
        }
        if (pathname === "/_internal/task-wait-probe" && req.method === "POST") {
          if (authKind !== "bearer") return new Response("forbidden\n", { status: 403 });
          try {
            const body = await req.json().catch(() => null);
            const id = body && typeof body === "object" && !Array.isArray(body) ? (body as { id?: unknown }).id : undefined;
            if (typeof id !== "string" || !id) {
              const { CoreError } = await import("../core/errors");
              throw new CoreError("invalid_input", "id required");
            }
            const { taskWaitProbe } = await import("../api/task-wait-bridge");
            return Response.json({ result: taskWaitProbe(getCtx(), id) });
          } catch (error) {
            const { toApiError, httpStatus } = await import("../api/errors");
            const body = toApiError(error);
            return Response.json({ error: body }, { status: httpStatus(body.code) });
          }
        }
        if (pathname === "/_internal/task-stop-probe" && req.method === "POST") {
          if (authKind !== "bearer") return new Response("forbidden\n", { status: 403 });
          try {
            const body = await req.json().catch(() => null);
            const id = body && typeof body === "object" && !Array.isArray(body) ? (body as { id?: unknown }).id : undefined;
            if (typeof id !== "string" || !id) {
              const { CoreError } = await import("../core/errors");
              throw new CoreError("invalid_input", "id required");
            }
            const { taskStopProbe } = await import("../api/task-stop-bridge");
            return Response.json({ result: taskStopProbe(getCtx(), id) });
          } catch (error) {
            const { toApiError, httpStatus } = await import("../api/errors");
            const body = toApiError(error);
            return Response.json({ error: body }, { status: httpStatus(body.code) });
          }
        }
        if (pathname === "/_internal/task-review-probe" && req.method === "POST") {
          if (authKind !== "bearer") return new Response("forbidden\n", { status: 403 });
          try {
            const body = await req.json().catch(() => null);
            const record = body && typeof body === "object" && !Array.isArray(body) ? body as { id?: unknown; verdict?: unknown } : {};
            const id = record.id;
            if (typeof id !== "string" || !id) {
              const { CoreError } = await import("../core/errors");
              throw new CoreError("invalid_input", "id required");
            }
            const { taskReviewProbe } = await import("../api/task-review-bridge");
            return Response.json({ result: taskReviewProbe(getCtx(), id, record) });
          } catch (error) {
            const { toApiError, httpStatus } = await import("../api/errors");
            const body = toApiError(error);
            return Response.json({ error: body }, { status: httpStatus(body.code) });
          }
        }
        if (pathname === "/_internal/task-review-effects" && req.method === "POST") {
          if (authKind !== "bearer") return new Response("forbidden\n", { status: 403 });
          try {
            const body = await req.json().catch(() => null);
            const record = body && typeof body === "object" && !Array.isArray(body)
              ? body as { id?: unknown; verdict?: unknown; kind?: unknown; note?: unknown }
              : {};
            const id = record.id;
            const verdict = record.verdict;
            const kind = record.kind;
            const note = record.note;
            if (typeof id !== "string" || !id) {
              const { CoreError } = await import("../core/errors");
              throw new CoreError("invalid_input", "id required");
            }
            if (verdict !== "accept" && verdict !== "reject") {
              const { CoreError } = await import("../core/errors");
              throw new CoreError("invalid_input", "verdict required");
            }
            const { taskReviewAfterStore } = await import("../api/task-review-bridge");
            return Response.json({
              result: await taskReviewAfterStore(
                getCtx(),
                id,
                verdict,
                typeof kind === "string" ? kind : undefined,
                typeof note === "string" ? note : undefined,
              ),
            });
          } catch (error) {
            const { toApiError, httpStatus } = await import("../api/errors");
            const body = toApiError(error);
            return Response.json({ error: body }, { status: httpStatus(body.code) });
          }
        }
        if (pathname === "/_internal/task-stop-effects" && req.method === "POST") {
          if (authKind !== "bearer") return new Response("forbidden\n", { status: 403 });
          try {
            const body = await req.json().catch(() => null);
            const record = body && typeof body === "object" && !Array.isArray(body) ? body as { id?: unknown; beforeState?: unknown } : {};
            const id = record.id;
            const beforeState = record.beforeState;
            if (typeof id !== "string" || !id) {
              const { CoreError } = await import("../core/errors");
              throw new CoreError("invalid_input", "id required");
            }
            const { taskStopAfterStore } = await import("../api/task-stop-bridge");
            return Response.json({
              result: await taskStopAfterStore(
                getCtx(),
                id,
                typeof beforeState === "string" ? beforeState : null,
              ),
            });
          } catch (error) {
            const { toApiError, httpStatus } = await import("../api/errors");
            const body = toApiError(error);
            return Response.json({ error: body }, { status: httpStatus(body.code) });
          }
        }
        if (pathname === "/_internal/task-auto-clean" && req.method === "POST") {
          if (authKind !== "bearer") return new Response("forbidden\n", { status: 403 });
          try {
            const body = await req.json().catch(() => null);
            const ids = body && typeof body === "object" && !Array.isArray(body) ? (body as { ids?: unknown }).ids : undefined;
            if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) {
              const { CoreError } = await import("../core/errors");
              throw new CoreError("invalid_input", "ids required");
            }
            const { taskAutoCleanBridge } = await import("../api/task-clean-bridge");
            return Response.json({ result: await taskAutoCleanBridge(getCtx(), ids) });
          } catch (error) {
            const { toApiError, httpStatus } = await import("../api/errors");
            const body = toApiError(error);
            return Response.json({ error: body }, { status: httpStatus(body.code) });
          }
        }
        if (pathname === "/_internal/msg-effects" && req.method === "POST") {
          if (authKind !== "bearer") return new Response("forbidden\n", { status: 403 });
          try {
            const body = await req.json().catch(() => null);
            const { msgEffectsBridge } = await import("../api/msg-bridge");
            return Response.json({ result: await msgEffectsBridge(getCtx(), body, opts.opDeps?.spawnRunner) });
          } catch (error) {
            const { toApiError, httpStatus } = await import("../api/errors");
            const body = toApiError(error);
            return Response.json({ error: body }, { status: httpStatus(body.code) });
          }
        }
        if (pathname === "/_internal/snapshot-probe-parts" && req.method === "POST") {
          if (authKind !== "bearer") return new Response("forbidden\n", { status: 403 });
          try {
            const { snapshotProbeParts } = await import("../api/snapshot-probe-bridge");
            return Response.json({ result: await snapshotProbeParts(getCtx()) });
          } catch (error) {
            const { toApiError, httpStatus } = await import("../api/errors");
            const body = toApiError(error);
            return Response.json({ error: body }, { status: httpStatus(body.code) });
          }
        }
        if (pathname === "/_internal/setup-effects" && req.method === "POST") {
          if (authKind !== "bearer") return new Response("forbidden\n", { status: 403 });
          try {
            const body = await req.json().catch(() => null);
            const request = body && typeof body === "object" && !Array.isArray(body) ? (body as { request?: unknown }).request : undefined;
            const { setupEffectsBridge } = await import("../api/setup-bridge");
            return Response.json({ result: await setupEffectsBridge(getCtx(), request, opts.opDeps) });
          } catch (error) {
            const { toApiError, httpStatus } = await import("../api/errors");
            const body = toApiError(error);
            return Response.json({ error: body }, { status: httpStatus(body.code) });
          }
        }
        if (pathname === "/_internal/setup-check" && req.method === "POST") {
          if (authKind !== "bearer") return new Response("forbidden\n", { status: 403 });
          try {
            const body = await req.json().catch(() => ({}));
            const snapshotProbe = body && typeof body === "object" && !Array.isArray(body)
              ? (body as { snapshotProbe?: unknown }).snapshotProbe
              : undefined;
            const { setupCheckBridge } = await import("../api/setup-check-bridge");
            return Response.json({
              result: await setupCheckBridge(getCtx(), typeof snapshotProbe === "boolean" ? snapshotProbe : false),
            });
          } catch (error) {
            const { toApiError, httpStatus } = await import("../api/errors");
            const body = toApiError(error);
            return Response.json({ error: body }, { status: httpStatus(body.code) });
          }
        }
        // The front door's LAN radio: it pulls its advert config and pushes raw observations (SEC-11, SEC-16).
        if (pathname === "/_internal/discovery/config" && req.method === "POST") {
          const { buildRadioConfig } = await import("../discovery/radio");
          return Response.json(await buildRadioConfig(getCtx()));
        }
        if (pathname === "/_internal/discovery/observed" && req.method === "POST") {
          if (Number(req.headers.get("content-length") ?? 0) > DISCOVERY_BODY_MAX) return new Response("too large\n", { status: 413 });
          const text = await req.text().catch(() => "");
          if (Buffer.byteLength(text, "utf8") > DISCOVERY_BODY_MAX) return new Response("too large\n", { status: 413 });
          let body: { observations?: unknown } | null = null;
          try { body = JSON.parse(text); } catch {}
          const batch = Array.isArray(body?.observations) ? body.observations : [];
          // The network from the radio's last config pull, so each poll probes the network once (N4).
          const { radioNetwork, recordObservations } = await import("../discovery/radio");
          return Response.json(await recordObservations(getCtx(), batch, { network: radioNetwork() }));
        }
      } else {
        if (req.method === "OPTIONS") return pathname.startsWith("/app/") ? appPage("Method not allowed.", 405) : new Response("method not allowed\n", { status: 405 });
        const headers = { "X-Pacer": "1" };
        if (req.method === "GET" && pathname === "/health") return Response.json({ ok: true, pid: process.pid }, { headers });
        if (pathname === "/app/auth") return appRoute(req, getCtx());
        bearer = safeEqual(req.headers.get("authorization") ?? "", `Bearer ${token}`);
        const candidate = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        if (!bearer && /^(?:pwg|pet)_[0-9a-f]{64}$/.test(candidate)) {
          if (req.method !== "POST" || !pathname.startsWith("/v3/ops/")) return new Response("forbidden\n", { status: 403 });
          if(candidate.startsWith("pet_"))enforcementToken=candidate;else workGrant=candidate;
        }
        if (!bearer && !workGrant && !enforcementToken) {
          const value = (req.headers.get("cookie") ?? "").split(";").map(c => c.trim()).find(c => c.startsWith("pacer_session="))?.slice("pacer_session=".length);
          if (!(app || /^\/v[23]\//.test(pathname)) || !value || !checkSession(getCtx(), value)) {
            return app ? appPage("Session ended. Run `pacer open`.", 401) : new Response("unauthorized\n", { status: 401 });
          }
          if (/^\/v[23]\/session\/exchange$/.test(pathname)) return new Response("forbidden\n", { status: 403 });
          const site = req.headers.get("sec-fetch-site");
          if (((sessionRoute || terminalRoute || agentSessionRoute) && !hosts.map(host => `http://${host}`).includes(req.headers.get("origin") ?? "")) || (site !== null && !["same-origin", "none"].includes(site)) ||
              (!["GET", "HEAD"].includes(req.method) &&
               (!hosts.map(host => `http://${host}`).includes(req.headers.get("origin") ?? "") || req.headers.get("x-pacer-client") !== "app"))) {
            return app ? appPage("Forbidden.", 403) : new Response("forbidden\n", { status: 403 });
          }
        }
      }
      const requestCtx = workGrant ? () => ({...getCtx(),env:{...getCtx().env,PACER_WORK_GRANT:workGrant,PACER_ROLE:"executor"}})
        : enforcementToken ? () => ({...getCtx(),env:{...getCtx().env,PACER_ENFORCEMENT_TOKEN:enforcementToken,PACER_ROLE:"executor"}}) : getCtx;
      if (workGrant) {
        try { authorizeWorkGrant(requestCtx(), workGrant); }
        catch { return new Response("forbidden\n", { status: 403 }); }
      }
      if(enforcementToken){
        if(pathname!=="/v3/ops/dispatch.enforcement.denied")return new Response("forbidden\n",{status:403});
        try {authorizeEnforcementToken(requestCtx(),enforcementToken);}
        catch{return new Response("forbidden\n",{status:403});}
      }
      if (app) return appRoute(req, getCtx());
      const attachmentResponse = await attachmentRoute(req, getCtx());
      if (attachmentResponse) return attachmentResponse;
      const captureResponse = await desktopCaptureRoute(req, getCtx());
      if (captureResponse) return captureResponse;
      if (sessionRoute) return upgradeSession(req, server, getCtx(), sessionRoute[1]!);
      if (agentSessionRoute) {
        if (workGrant || isExecutorSession(requestCtx())) return new Response("forbidden\n", {status:403});
        return upgradeAgentSession(req,server,getCtx(),agentSessionRoute[1]!,agentSessionRoute[2]!);
      }
      if (terminalRoute) {
        if (workGrant || isExecutorSession(requestCtx())) return new Response("forbidden\n", { status: 403 });
        return upgradeTerminal(req, server, getCtx(), terminalRoute[1]!);
      }
      if (/^\/v[23]\//.test(pathname)) {
        // The local TUI holds the bearer token and proves the human with an app session it exchanged for
        // (X-Pacer-Session). A bearer alone stays the non-privileged `external:local`, and only identity changes:
        // terminals and settings keep bearer behavior.
        const session = req.headers.get("x-pacer-session") ?? "";
        const humanSession = bearer && !workGrant && !enforcementToken && /^[0-9a-f]{64}$/.test(session) && checkSession(getCtx(), session);
        const response=await handleV2(req, { getCtx: requestCtx, opDeps: {...opts.opDeps, usageRefreshDone: refreshStatusAfterPending, snapshotProbe:false, terminalPresetsOnly: !bearer,appAuthenticated:!bearer&&!workGrant, ...(humanSession ? {participant: "human"} : {})}, tailMs, status, snapshot: () => readCache.get() });
        if (response.ok && req.method === "POST" && /^\/v[23]\/ops\/mode\.(hold|release)$/.test(pathname)) {
          await readCache.refreshAfterPending();
        }
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
    // Internal mode sits behind the Rust front door, which owns the public port and answers health itself.
    if (opts.internal || opts.listener === false) {
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
  const history = startTaskHistory(initialCtx);
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
  let cleaning = false;
  const sweep = () => {
    if (stopped || cleaning) return;
    cleaning = true;
    void Promise.resolve().then(async () => {
      const ctx = getCtx();
      await autoCleanSweep(ctx);
    }).catch(error => console.warn(`pacer: automatic cleanup failed: ${String(error)}`))
      .finally(() => { cleaning = false; });
  };
  if (!bg) {
    cleanStart = setTimeout(sweep, 0);
    cleanTimer = setInterval(sweep, 60 * 60_000);
  }
  let supervising = false;
  // One supervisor at a time: while the worker owns supervision this loop stands by,
  // and it resumes if the worker fails (its guards are per isolate, not shared).
  let workerSupervises = false, workerHeartbeat = 0;
  const WORKER_SILENCE_MS = 60_000;
  const resumeInProcess = (reason: string) => {
    if (!workerSupervises) return;
    if (!stopped) console.error(`pacer: supervision worker ${reason}; supervising in process`);
    workerSupervises = false;
    worker?.terminate();
    worker = undefined;
  };
  // Bounds the JSON reconcile to at most once per 60s, off the request path, matching
  // the supervision Worker's own cadence (src/tasks/supervision-worker.ts).
  let lastReconcileAt = 0;
  const RECONCILE_INTERVAL_MS = 60_000;
  const supervise = () => {
    // A worker that exits or idles without an error event must not stop supervision.
    if (workerSupervises && Date.now() - workerHeartbeat > WORKER_SILENCE_MS) resumeInProcess("went silent");
    if (stopped || supervising || workerSupervises) return;
    if (Date.now() - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
      lastReconcileAt = Date.now();
      try { reconcileTaskJson(getCtx()); }
      catch (error) { if (!stopped) console.error(`pacer: in-process task reconcile failed: ${String(error)}`); }
    }
    supervising = true;
    void superviseTasks(getCtx(), opts.opDeps?.spawnRunner, () => stopped)
      .catch(error => { if (!stopped) console.error(`pacer: task supervision failed: ${String(error)}`); })
      .finally(() => { supervising = false; });
  };
  const supervisorTimer = setInterval(supervise, 5000);
  let worker: Worker | undefined;
  const startSupervisionWorker = () => {
    // Only the pacer serve command opts in: the worker builds its own context and
    // spawns real runners, so tests and embeddings keep the in-process supervisor.
    if (worker || stopped || !opts.supervisionWorker || opts.opDeps?.spawnRunner) return;
    try {
      // A compiled binary gives every module the bundle root's import.meta.url
      // (/$bunfs/root/...); worker entrypoints land at /$bunfs/root/<source>.js.
      const compiled = import.meta.url.includes("/$bunfs/");
      worker = new Worker(compiled ? new URL("./src/tasks/supervision-worker.js", import.meta.url) : new URL("../tasks/supervision-worker.ts", import.meta.url), { type: "module" });
      worker.postMessage({
        type: "init",
        pacerHome: initialCtx.pacerHome,
        env: initialCtx.env,
        selfCommand: selfCommand(),
      });
      workerSupervises = true;
      workerHeartbeat = Date.now();
      worker.onmessage = (event: MessageEvent<{ type?: string; reason?: string }>) => {
        if (event.data?.type === "heartbeat") workerHeartbeat = Date.now();
        else if (event.data?.type === "failed") resumeInProcess(`failed to start: ${event.data.reason}`);
      };
      worker.onerror = (err) => resumeInProcess(`error: ${err.message}`);
      worker.onmessageerror = (err) => resumeInProcess(`message error: ${String(err)}`);
      worker.addEventListener("close", () => resumeInProcess("exited"));
    } catch (error) {
      if (!stopped) console.error(`pacer: failed to start supervision worker: ${String(error)}`);
      worker = undefined;
    }
  };
  startSupervisionWorker();
  // Background periodic worker (spec §5): the pump, broker, clean sweep, certification,
  // usage and observations run off the request thread in one Worker with its own SQLite
  // connection. Health is mirrored to state/background-worker.json (written only on
  // state change) so diagnostics can report it. On death or sustained silence the
  // Worker is asked to stop gracefully — its current loop finishes and releases file
  // locks — and only after a bounded grace period is it force-terminated; then it is
  // restarted with backoff (no silent fallback to the request thread). The restart
  // backoff clears once the worker has been healthy for 10 minutes. The _internal/*
  // bridges and status refresh stay on the request thread because request handlers need
  // them synchronously.
  const bgDiag: { state: string; restarts: number; startedAt: number; lastError: string | null; lastHeartbeatAt: number; loops: Record<string, { at: number; ok: boolean }>; managed: string[] } =
    { state: "stopped", restarts: 0, startedAt: 0, lastError: null, lastHeartbeatAt: 0, loops: {}, managed: [] };
  let lastBgDiagSig = "";
  const writeBgDiag = () => {
    if (!bg) return;
    // Write only on state change: heartbeats advance lastHeartbeatAt but must not touch the file.
    const sig = JSON.stringify([bgDiag.state, bgDiag.restarts, bgDiag.lastError, bgDiag.managed, bgDiag.loops]);
    if (sig === lastBgDiagSig) return;
    lastBgDiagSig = sig;
    try { const dir = join(initialCtx.pacerHome, "state"); mkdirSync(dir, { recursive: true }); writeJsonAtomic(join(dir, "background-worker.json"), bgDiag); }
    catch { /* best-effort diagnostics */ }
  };
  let bgWorker: Worker | undefined;
  let bgRestartTimer: ReturnType<typeof setTimeout> | undefined;
  let bgGraceTimer: ReturnType<typeof setTimeout> | undefined;
  let bgSilentTicks = 0;
  let bgHeartbeatSinceTick = false;
  let bgBackoffExp = 0;   // grows per restart, cleared after sustained health
  let bgLastStartAt = 0;  // reset on each healthy start
  const bgMonitorMs = opts.bgMonitorMs ?? 5000;
  const bgSilenceTicks = opts.bgSilenceTicks ?? 12; // ~60s at 5s monitor ticks
  const bgStopGraceMs = opts.bgStopGraceMs ?? 5000;
  const bgHeartbeatMs = opts.bgHeartbeatMs ?? 5000;
  const bgUsageMs = opts.bgUsageMs;
  const BG_BACKOFF_RESET_MS = 10 * 60_000;
  const scheduleBgRestart = () => {
    if (bgRestartTimer || stopped) return;
    const backoff = Math.min(1000 * 2 ** Math.max(0, bgBackoffExp - 1), 30_000);
    bgRestartTimer = setTimeout(() => { bgRestartTimer = undefined; startBackgroundWorker(); }, backoff);
  };
  const bgTrackRestart = (reason: string) => {
    if (stopped) return;
    bgDiag.lastError = reason; bgDiag.restarts += 1; bgBackoffExp += 1; bgLastStartAt = Date.now();
    bgDiag.state = "restarting"; writeBgDiag();
    if (!stopped) console.error(`pacer: background worker ${reason}; restarting with backoff`);
  };
  // Death from an error or sustained silence: ask the worker to stop itself so the
  // current loop finishes and releases file locks, and force-terminate only if it
  // does not exit within the bounded grace.
  const bgRestartAfterStop = (reason: string) => {
    if (!bgWorker || stopped) return;
    bgTrackRestart(reason);
    const w = bgWorker;
    try { w.postMessage({ type: "stop" }); } catch { /* already gone; close will clean up */ }
    if (bgGraceTimer) clearTimeout(bgGraceTimer);
    bgGraceTimer = setTimeout(() => {
      bgGraceTimer = undefined;
      if (bgWorker === w) {
        try { w.terminate(); } catch { /* already gone */ }
        bgWorker = undefined;
      }
      scheduleBgRestart();
    }, bgStopGraceMs);
  };
  const bgClose = () => {
    const graceful = bgGraceTimer !== undefined;
    if (graceful) { clearTimeout(bgGraceTimer); bgGraceTimer = undefined; }
    if (!graceful && bgWorker) bgTrackRestart("exited");
    bgWorker = undefined;
    scheduleBgRestart();
  };
  const startBackgroundWorker = () => {
    if (bgWorker || stopped || !bg || bgRestartTimer) return;
    try {
      bgWorker = new Worker(backgroundWorkerEntryURL(import.meta.url).href, { type: "module" });
      bgDiag.state = "starting"; bgDiag.startedAt = Date.now(); bgDiag.lastHeartbeatAt = Date.now();
      bgLastStartAt = Date.now(); bgSilentTicks = 0; bgHeartbeatSinceTick = false; writeBgDiag();
      bgWorker.postMessage({
        type: "init",
        pacerHome: initialCtx.pacerHome,
        env: initialCtx.env,
        selfCommand: selfCommand(),
        pumpMs,
        ...(typeof bgHeartbeatMs === "number" ? { heartbeatMs: bgHeartbeatMs } : {}),
        ...(typeof bgUsageMs === "number" ? { usageMs: bgUsageMs } : {}),
      });
      bgWorker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
        const d = event.data ?? {};
        if (d.type === "heartbeat") { bgHeartbeatSinceTick = true; bgDiag.lastHeartbeatAt = Date.now(); bgDiag.state = "running"; bgLastStartAt = Date.now(); writeBgDiag(); }
        else if (d.type === "outbox") { try { notifyOutbox(initialCtx); } catch { /* SSE wake must not take the thread down */ } }
        else if (d.type === "loop" && typeof d.name === "string") {
          bgDiag.loops[d.name] = { at: Date.now(), ok: d.ok === true }; writeBgDiag();
          // The usage loop owns refreshAllUsage; once it reports ok, recompute status
          // on the main thread, exactly as the in-process path used to.
          if (d.name === "usage" && d.ok === true) { void refreshStatusAfterPending(); }
        }
        else if (d.type === "loops" && Array.isArray(d.names)) { bgDiag.managed = (d.names as unknown[]) as string[]; writeBgDiag(); }
        else if (d.type === "failed") { bgRestartAfterStop(`failed to start: ${String(d.reason ?? "")}`); }
      };
      bgWorker.onerror = (err) => bgRestartAfterStop(`error: ${err.message}`);
      bgWorker.onmessageerror = (err) => bgRestartAfterStop(`message error: ${String(err)}`);
      bgWorker.addEventListener("close", bgClose);
    } catch (error) {
      bgWorker = undefined;
      bgDiag.lastError = error instanceof Error ? error.message : String(error);
      bgDiag.state = "restarting"; writeBgDiag();
      if (!stopped) console.error(`pacer: failed to start background worker: ${bgDiag.lastError}; retrying`);
      bgBackoffExp += 1; bgLastStartAt = Date.now();
      scheduleBgRestart();
    }
  };
  const bgMonitorTimer = bg ? setInterval(() => {
    if (stopped) return;
    // A main-thread stall can delay delivered heartbeats, so count silence in
    // monitor ticks rather than wall-clock Date.now() deltas.
    if (bgWorker && !bgGraceTimer) {
      if (bgHeartbeatSinceTick) { bgSilentTicks = 0; }
      else { bgSilentTicks += 1; if (bgSilentTicks > bgSilenceTicks) bgRestartAfterStop("went silent"); }
      bgHeartbeatSinceTick = false;
      if (bgLastStartAt && Date.now() - bgLastStartAt > BG_BACKOFF_RESET_MS) { bgBackoffExp = 0; bgLastStartAt = 0; }
    }
  }, bgMonitorMs) : undefined;
  startBackgroundWorker();
  let certifying = false;
  const certify = () => {
    if (stopped || certifying) return;
    certifying = true;
    void certificationTick(getCtx())
      .catch(error => { if (!stopped) console.warn(`pacer: certification probe tick failed: ${String(error)}`); })
      .finally(() => { certifying = false; });
  };
  if (!bg) certificationTimer = setInterval(certify, 10 * 60_000);
  let brokering = false;
  const broker = () => {
    if (stopped || brokering) return;
    brokering = true;
    void brokerTick(getCtx(), { spawnRunner: opts.opDeps?.spawnRunner, mode: async () => {
      try { return (await status()).mode; } catch { return undefined; }
    } }).catch(error => { if (!stopped) console.error(`pacer: messaging broker failed: ${String(error)}`); })
      .finally(() => { brokering = false; });
  };
  if (!bg) brokerTimer = setInterval(broker, 15_000);
  const refreshUsage = () => {
    if (stopped) return;
    void refreshAllUsage({ ...getCtx(), now: Date.now() / 1000 }, true)
      .then(refreshStatusAfterPending)
      .catch(error => { if (!stopped) console.error(`pacer: usage refresh failed: ${String(error)}`); });
  };
  if (!bg) {
    usageStart = setTimeout(refreshUsage, 1000);
    usageTimer = setInterval(refreshUsage, 15 * 60_000);
  }
  const snapshotTimer=setInterval(refreshSnapshot,2000);
  const statusTimer=setInterval(refreshStatus,60000);
  if (!bg) observationTimer = pumpMs>0?setInterval(()=>{if(!stopped)void refreshObservations(getCtx()).catch(()=>{});},60000):undefined;
  const terminalTimer=setInterval(()=>{if(!stopped)void Promise.resolve().then(()=>refreshConsoleTerminals(getCtx())).catch(()=>{});},10000);
  if (!bg) pumpTimer = pumpMs > 0 ? setInterval(tick, pumpMs) : undefined;
  return { port: publicPort, token, stop: () => {
    nativeServices?.native.stop();
    desktopUpdates.stop();
    unbindDesktopUpdates();
    listener?.stop();
    readCache.stop();
    unregisterJobs();
    stopped = true;
    clearTimeout(cleanStart);
    clearInterval(cleanTimer);
    clearInterval(supervisorTimer);
    clearInterval(certificationTimer);
    clearInterval(brokerTimer);
    clearTimeout(usageStart);
    clearInterval(usageTimer);
    clearInterval(pumpTimer);
    clearInterval(snapshotTimer);
    clearInterval(statusTimer);
    clearInterval(observationTimer);
    clearInterval(terminalTimer);
    clearTimeout(scheduled);
    worker?.terminate();
    clearTimeout(bgRestartTimer);
    if (bgMonitorTimer) clearInterval(bgMonitorTimer);
    if (bgGraceTimer) clearTimeout(bgGraceTimer);
    if (bgWorker) {
      // Ask the worker to finish its current loop and release file locks, then
      // force-terminate after a bounded grace (the service is going away).
      const w = bgWorker;
      try { w.postMessage({ type: "stop" }); } catch { /* already gone */ }
      setTimeout(() => { try { w.terminate(); } catch { /* already gone */ } }, bgStopGraceMs);
      bgWorker = undefined;
    }
    for (const watcher of watchers) watcher.close();
    server.stop(true);
    return Promise.all([history.stop(), shutdownPlugins(initialCtx)]).then(() => {});
  }, backgroundWorker: () => bgWorker };
}
