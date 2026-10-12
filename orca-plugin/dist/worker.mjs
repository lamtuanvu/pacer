// orca-plugin/src/worker.ts
import { get, request } from "node:http";
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join as join2, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// orca-plugin/src/plugin.ts
import { join } from "node:path";

// src/link/envelope.ts
var LIMITS = { providers: 32, tasks: 20, alerts: 10, goal: 200, title: 120, body: 1000, id: 128, cmdLine: 4096, heartbeatS: 30 };
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var str = (v, max) => typeof v === "string" ? v.slice(0, max) : null;
var optStr = (v, max) => typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
var LEVELS = ["info", "warn", "error"];
function clip(s, max) {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 3))}...`;
}
function parseBudget(d) {
  if (!isObj(d))
    return null;
  const generatedAt = num(d.generatedAt), strategy = str(d.strategy, 128), planner = str(d.planner, 64), mode = str(d.mode, 32);
  if (generatedAt === null || strategy === null || planner === null || mode === null)
    return null;
  const providers = (Array.isArray(d.providers) ? d.providers : []).slice(0, LIMITS.providers).flatMap((p) => {
    if (!isObj(p))
      return [];
    const id = str(p.id, 64), verdict = str(p.verdict, 32);
    if (id === null || verdict === null)
      return [];
    return [{ id, verdict, usedPct: num(p.usedPct), pacePct: num(p.pacePct), resetsAt: num(p.resetsAt), window: optStr(p.window, 32), stale: p.stale === true, ...optStr(p.brokenReason, 500) ? { brokenReason: optStr(p.brokenReason, 500) } : {}, ...optStr(p.blockedReason, 500) ? { blockedReason: optStr(p.blockedReason, 500), blockedUntil: num(p.blockedUntil) } : {} }];
  });
  const ranked = (Array.isArray(d.ranked) ? d.ranked : []).slice(0, LIMITS.providers).flatMap((r) => {
    if (!isObj(r))
      return [];
    const id = str(r.id, 64), verdict = str(r.verdict, 32);
    return id === null || verdict === null ? [] : [{ id, verdict }];
  });
  return { generatedAt, strategy, planner, mode, providers, ranked };
}
function parseTask(d) {
  if (!isObj(d))
    return null;
  const id = str(d.id, LIMITS.id), state = str(d.state, 16), updatedAt = num(d.updatedAt);
  if (!id || !state || updatedAt === null)
    return null;
  return {
    id,
    state,
    updatedAt,
    goal: str(d.goal, LIMITS.goal) ?? "",
    executor: optStr(d.executor, 64),
    backend: optStr(d.backend, 32),
    worktree: optStr(d.worktree, 4096),
    ...d.dismissed === true ? { dismissed: true } : {},
    ...optStr(d.retriedBy, 128) ? { retriedBy: optStr(d.retriedBy, 128) } : {},
    ...optStr(d.retryOf, 128) ? { retryOf: optStr(d.retryOf, 128) } : {},
    ...optStr(d.brokenExecutor, 64) ? { brokenExecutor: optStr(d.brokenExecutor, 64) } : {},
    ...optStr(d.brokenReason, 500) ? { brokenReason: optStr(d.brokenReason, 500) } : {},
    ...num(d.attemptStartedAt) !== null ? { attemptStartedAt: num(d.attemptStartedAt) } : {},
    ...typeof d.runnerAlive === "boolean" ? { runnerAlive: d.runnerAlive } : {}
  };
}
function parseMode(d) {
  if (!isObj(d))
    return null;
  const mode = str(d.mode, 32), strategy = str(d.strategy, 128), at = num(d.at);
  if (!mode || strategy === null || at === null)
    return null;
  return { mode, strategy, at, previous: optStr(d.previous, 32) };
}
function parseAlert(d) {
  if (!isObj(d))
    return null;
  const error = optStr(d.error, LIMITS.body), level = LEVELS.includes(d.level) ? d.level : error ? "error" : "info";
  const alert = { key: optStr(d.key, LIMITS.id) ?? "alert", level, title: clip(optStr(d.title, 4096) ?? "pacer", LIMITS.title), body: clip(str(d.body, 4096) ?? error ?? "", LIMITS.body), at: num(d.at) ?? 0 };
  if (error)
    alert.error = error;
  const n = d.notification;
  if (isObj(n) && ["failed", "done", "broken", "quota", "strategy", "session"].includes(String(n.kind)))
    alert.notification = { kind: n.kind, ...n.fromPanel === true ? { fromPanel: true } : {}, ...n.near === true ? { near: true } : {}, ...optStr(n.executor, 64) ? { executor: optStr(n.executor, 64) } : {}, ...optStr(n.goal, 1000) ? { goal: optStr(n.goal, 1000) } : {}, ...optStr(n.nextExecutor, 64) ? { nextExecutor: optStr(n.nextExecutor, 64) } : {}, ...optStr(n.strategy, 128) ? { strategy: optStr(n.strategy, 128) } : {}, ...num(n.resetsAt) !== null ? { resetsAt: num(n.resetsAt) } : {} };
  return alert;
}
function parseConsole(d) {
  if (!isObj(d))
    return null;
  const pid = num(d.pid), startedAt = num(d.startedAt), heartbeatAt = num(d.heartbeatAt);
  if (pid === null || startedAt === null || heartbeatAt === null)
    return null;
  return { ...optStr(d.version, 64) ? { version: optStr(d.version, 64) } : {}, ...optStr(d.worktreeId, 1024) ? { worktreeId: optStr(d.worktreeId, 1024) } : {}, pid, startedAt, heartbeatAt, ...num(d.busyUntil) !== null ? { busyUntil: num(d.busyUntil) } : {}, handle: optStr(d.handle, 1024), paneKey: optStr(d.paneKey, 2048) };
}
function parseEnvelope(raw) {
  if (!isObj(raw) || raw.v !== 1)
    return null;
  switch (raw.type) {
    case "budget": {
      const data = parseBudget(raw.data);
      return data && { v: 1, type: "budget", data };
    }
    case "task": {
      const data = parseTask(raw.data);
      return data && { v: 1, type: "task", data };
    }
    case "mode": {
      const data = parseMode(raw.data);
      return data && { v: 1, type: "mode", data };
    }
    case "alert": {
      const data = parseAlert(raw.data);
      return data && { v: 1, type: "alert", data };
    }
    default:
      return null;
  }
}
function emptySnapshot() {
  return { v: 1, seq: 0, at: 0, budget: null, mode: null, tasks: [], alerts: [], console: null, consoles: [], strategies: [] };
}
function parseSnapshot(raw) {
  if (!isObj(raw) || raw.v !== 1)
    return null;
  const seq = num(raw.seq), at = num(raw.at);
  if (seq === null || at === null)
    return null;
  const list = (v, f, max) => (Array.isArray(v) ? v : []).map(f).filter((x) => x !== null).slice(0, max);
  return { v: 1, seq, at, ...typeof raw.serviceInstalled === "boolean" ? { serviceInstalled: raw.serviceInstalled } : {}, budget: raw.budget == null ? null : parseBudget(raw.budget), mode: raw.mode == null ? null : parseMode(raw.mode), tasks: list(raw.tasks, parseTask, LIMITS.tasks), alerts: list(raw.alerts, parseAlert, LIMITS.alerts), console: raw.console == null ? null : parseConsole(raw.console), consoles: list(raw.consoles, parseConsole, 32), strategies: list(raw.strategies, (v) => typeof v === "string" ? optStr(v, 128) : isObj(v) && optStr(v.name, 128) ? { name: optStr(v.name, 128), active: v.active === true, summary: str(v.summary, 1000) ?? "", description: str(v.description, 1000) ?? "" } : null, 32) };
}
function reduce(s, e, at) {
  const next = { ...s, seq: s.seq + 1, at };
  switch (e.type) {
    case "budget":
      next.budget = e.data;
      break;
    case "mode":
      next.mode = e.data;
      break;
    case "task":
      next.tasks = [e.data, ...s.tasks.filter((t) => t.id !== e.data.id)].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, LIMITS.tasks);
      break;
    case "alert":
      next.alerts = [e.data, ...s.alerts.filter((a) => a.key !== e.data.key)].sort((a, b) => b.at - a.at).slice(0, LIMITS.alerts);
      break;
  }
  return next;
}
function contentKey(s) {
  return JSON.stringify({ serviceInstalled: s.serviceInstalled, budget: s.budget ? { ...s.budget, generatedAt: undefined } : null, mode: s.mode, tasks: s.tasks, alerts: s.alerts, console: s.console, consoles: s.consoles, strategies: s.strategies });
}
function liveConsole(s, nowS) {
  const c = s.console;
  return c && c.handle && nowS - c.heartbeatAt <= LIMITS.heartbeatS ? c : null;
}
var CMD_PREFIX = ": pacer '";
function encodeCmdLine(data) {
  const json = JSON.stringify({ v: 1, type: "cmd", data }).replace(/'/g, "\\u0027"), line = `${CMD_PREFIX}${json}'`;
  if (line.length > LIMITS.cmdLine)
    throw new Error(`pacer command line exceeds ${LIMITS.cmdLine} characters`);
  return line;
}
function summaryLine(b) {
  if (!b)
    return "pacer: no budget data yet";
  const p = b.providers.find((x) => x.id === b.planner), pct = p?.usedPct == null ? "?" : `${Math.round(p.usedPct)}%`;
  return clip(`pacer ${b.mode} | ${b.planner} ${pct} ${p?.verdict ?? "UNKNOWN"} | next: ${b.ranked[0]?.id ?? "none"}`, LIMITS.title);
}

// orca-plugin/src/settings.ts
function readSettings(raw, home) {
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  return {
    notifications: ["off", "important", "all"].includes(String(raw.notifications)) ? raw.notifications : "important",
    autoConsole: typeof raw.autoConsole === "boolean" ? raw.autoConsole : true,
    transport: ["auto", "http", "channel", "bridge"].includes(raw.transport) ? raw.transport : "auto",
    port: finite(raw.port) && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535 ? raw.port : 4317,
    pacerHome: typeof raw.pacerHome === "string" && raw.pacerHome.length > 0 ? raw.pacerHome : `${home}/.pacer`,
    pollSeconds: finite(raw.pollSeconds) ? Math.max(5, Math.min(300, raw.pollSeconds)) : 10,
    ...Array.isArray(raw.deliveredAlerts) ? { deliveredAlerts: raw.deliveredAlerts.filter((a) => !!a && typeof a === "object" && typeof a.key === "string" && finite(a.at)).slice(-200) } : {},
    lastAlertAt: finite(raw.lastAlertAt) && raw.lastAlertAt >= 0 ? raw.lastAlertAt : 0
  };
}

// orca-plugin/src/store.ts
class LinkStore {
  nowS;
  snapshot = emptySnapshot();
  transport = null;
  listeners = [];
  constructor(nowS) {
    this.nowS = nowS;
  }
  apply(e) {
    this.replace(reduce(this.snapshot, e, this.nowS()));
  }
  replace(s) {
    const changed = contentKey(s) !== contentKey(this.snapshot);
    this.snapshot = s;
    if (changed)
      for (const fn of this.listeners)
        fn(s);
  }
  onChange(fn) {
    this.listeners.push(fn);
  }
}

// orca-plugin/src/transports/choose.ts
var TRANSPORT_ORDER = ["http", "channel", "bridge"];
async function chooseTransport(ts, forced) {
  const probe = async (t) => {
    try {
      return await t.probe();
    } catch {
      return false;
    }
  };
  if (forced !== "auto") {
    const transport = ts.find((t) => t.id === forced) ?? null;
    return { transport, reachable: transport ? await probe(transport) : false };
  }
  for (const id of TRANSPORT_ORDER) {
    const transport = ts.find((t) => t.id === id);
    if (transport && await probe(transport))
      return { transport, reachable: true };
  }
  return { transport: null, reachable: false };
}

// orca-plugin/src/transports/http.ts
function httpTransport(o) {
  const base = `http://127.0.0.1:${o.port}`;
  async function request(path, token) {
    let cancel = () => {};
    try {
      return await Promise.race([
        o.http.get(base + path, token, 1500),
        new Promise((resolve) => {
          cancel = o.timers.after(1500, () => resolve(null));
        })
      ]);
    } catch {
      return null;
    } finally {
      cancel();
    }
  }
  async function identified() {
    const health = await request("/health", "");
    return health?.status === 200 && health.headers?.["x-pacer"] === "1";
  }
  async function get() {
    try {
      if (!await identified())
        return null;
      const token = o.readToken();
      if (!token)
        return null;
      const response = await request("/link", token);
      return response?.headers?.["x-pacer"] === "1" ? response : null;
    } catch {
      return null;
    }
  }
  async function snapshot() {
    const r = await get();
    if (r?.status !== 200)
      return null;
    try {
      return parseSnapshot(JSON.parse(r.body));
    } catch {
      return null;
    }
  }
  return {
    id: "http",
    probe: async () => (await get())?.status === 200,
    snapshot,
    watch(onEnvelope, onSnapshot, onFailure) {
      let stopped = false, failures = 0;
      let stopStream = () => {}, cancelRetry = () => {};
      let refreshBusy = false;
      const reconnect = () => {
        if (stopped)
          return;
        const delay = [2000, 4000, 8000, 16000, 30000][Math.min(failures++, 4)];
        cancelRetry();
        cancelRetry = o.timers.after(delay, () => {
          connect();
        });
      };
      const connect = async () => {
        if (stopped)
          return;
        stopStream();
        try {
          if (!await identified()) {
            reconnect();
            return;
          }
          if (stopped)
            return;
          const token = o.readToken();
          if (!token) {
            reconnect();
            return;
          }
          stopStream = o.http.stream(`${base}/events`, token, (chunk) => {
            for (const line of chunk.split(/\r?\n/)) {
              if (!line.startsWith("data: "))
                continue;
              try {
                const e = parseEnvelope(JSON.parse(line.slice(6)));
                if (e) {
                  failures = 0;
                  onEnvelope(e);
                }
              } catch {}
            }
          }, reconnect);
        } catch {
          reconnect();
        }
      };
      const cancelPoll = o.timers.every(1e4, () => {
        if (refreshBusy)
          return;
        refreshBusy = true;
        snapshot().then((s) => {
          if (!stopped) {
            if (s)
              onSnapshot(s);
            else
              onFailure?.();
          }
        }).finally(() => {
          refreshBusy = false;
        });
      });
      connect();
      return () => {
        stopped = true;
        stopStream();
        cancelRetry();
        cancelPoll();
      };
    }
  };
}

// orca-plugin/src/transports/bridge.ts
function bridgeTransport(o) {
  async function snapshot() {
    try {
      return parseSnapshot((await o.host.call("storage.get", { key: "link" })).value);
    } catch {
      return null;
    }
  }
  return {
    id: "bridge",
    snapshot,
    probe: async () => await snapshot() !== null,
    watch(_onEnvelope, onSnapshot) {
      let key = null, stopped = false, busy = false;
      const cancel = o.timers.every(Math.min(o.pollMs, 1000), () => {
        if (busy)
          return;
        busy = true;
        snapshot().then((s) => {
          if (s && !stopped) {
            const next = contentKey(s);
            if (next !== key) {
              key = next;
              onSnapshot(s);
            }
          }
        }).finally(() => {
          busy = false;
        });
      });
      return () => {
        stopped = true;
        cancel();
      };
    }
  };
}

// orca-plugin/src/transports/channel.ts
var CHANNEL_EVENT = "plugin.message";
function channelTransport(o) {
  let listener = null;
  let registered = false;
  return {
    id: "channel",
    probe: async () => {
      try {
        await o.host.call("events.subscribe", { events: [CHANNEL_EVENT] });
        if (!registered) {
          o.registerEvent(CHANNEL_EVENT, (p) => {
            if (typeof p !== "object" || !p)
              return;
            const e = parseEnvelope(p.data);
            if (e)
              listener?.(e);
          });
          registered = true;
        }
        return true;
      } catch {
        return false;
      }
    },
    snapshot: async () => null,
    watch(onEnvelope) {
      listener = onEnvelope;
      return () => {
        listener = null;
      };
    }
  };
}

// orca-plugin/src/console-link.ts
async function focusedConsole(host, s, nowS) {
  try {
    const context = await host.call("workspace.readContext");
    const ids = new Set(context?.terminals.map((t) => t.id) ?? []);
    return [...s.consoles ?? [], ...s.console ? [s.console] : []].filter((c) => c.handle && ids.has(c.handle) && nowS - c.heartbeatAt <= 30).sort((a, b) => b.heartbeatAt - a.heartbeatAt)[0] ?? null;
  } catch {
    return null;
  }
}
var queues = new WeakMap;
async function sendToConsole(host, s, data, nowS) {
  const console = await focusedConsole(host, s, nowS);
  if (!console)
    return "no-console";
  let byTerminal = queues.get(host);
  if (!byTerminal) {
    byTerminal = new Map;
    queues.set(host, byTerminal);
  }
  const key = console.handle, queue = byTerminal.get(key) ?? { tail: Promise.resolve(), at: -Infinity };
  byTerminal.set(key, queue);
  const send = queue.tail.catch(() => {}).then(async () => {
    const delay = Math.max(0, 1000 - (Date.now() - queue.at), Math.min(1000, ((console.busyUntil ?? nowS) - nowS) * 1000));
    if (delay)
      await new Promise((r) => setTimeout(r, delay));
    try {
      return (await host.call("terminal.sendText", { terminalId: key, text: encodeCmdLine(data), enter: true })).accepted ? "sent" : "rejected";
    } catch {
      return "rejected";
    } finally {
      queue.at = Date.now();
    }
  });
  queue.tail = send;
  return send;
}
var NO_CONSOLE = { title: "No console in this worktree", body: "Type `pacer console` into a terminal in this worktree and press Enter, then retry." };

// src/link/notification.ts
var executorName = (id) => NAMES[id ?? ""] ?? "the executor";
var NAMES = { "claude-code": "Claude", codex: "Codex", cursor: "Cursor", agy: "Antigravity", byteplus: "BytePlus", opencode: "OpenCode", local: "Local model" };
function shortGoal(goal, max = 90) {
  const text = goal.replace(/\s+/g, " ").trim();
  if (text.length <= max)
    return text;
  const prefix = text.slice(0, max - 1), space = prefix.lastIndexOf(" ");
  return prefix.slice(0, space > max / 2 ? space : prefix.length) + "…";
}

// orca-plugin/src/notify.ts
var shownAt = new WeakMap;
async function deliverNotification(host, message, nowS) {
  if (nowS - (shownAt.get(host) ?? -Infinity) < 5)
    return false;
  const previous = shownAt.get(host);
  shownAt.set(host, nowS);
  try {
    const result = await host.call("notifications.show", message);
    if (result.delivered)
      return true;
  } catch (e) {
    if (previous === undefined)
      shownAt.delete(host);
    else
      shownAt.set(host, previous);
    throw e;
  }
  if (previous === undefined)
    shownAt.delete(host);
  else
    shownAt.set(host, previous);
  return false;
}
var states = new WeakMap;
var id = (a) => JSON.stringify([a.key, a.at]);
function notificationMessage(a) {
  const n = a.notification, name = executorName(n?.executor);
  const next = n?.nextExecutor ? `Moved to ${executorName(n.nextExecutor)} automatically.` : n?.kind === "failed" ? "Open the pacer panel to retry." : "Nothing to do.";
  let title = a.title.replace(/\bpacer\b[: ]*/gi, "").trim(), body = "Nothing to do.";
  if (n) {
    title = n.kind === "failed" ? `Task failed on ${name}` : n.kind === "done" ? `Task done on ${name}` : n.kind === "broken" ? `${name} isn't starting` : n.kind === "quota" ? `${name} ${n.near ? "is near its limit" : "is out of quota"}${!n.near && n.resetsAt ? ` until ${new Date(n.resetsAt * 1000).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "")}` : ""}` : n.kind === "strategy" ? `Switched to strategy ${n.strategy}` : "Strategy session opened";
    body = `${shortGoal(n.goal ?? "")}
${n.kind === "failed" && n.nextExecutor ? `Open the pacer panel to retry on ${executorName(n.nextExecutor)}.` : next}`;
  }
  if (!n)
    title = title.replace(/\bagy\b/g, "Antigravity").replace(/\bcodex\b/gi, "Codex").replace(/\bcursor\b/gi, "Cursor").replace(/\bclaude-code\b/g, "Claude").replace(/\s+(via|backend)\b.*$/i, "");
  return { title: shortGoal(title, 60), body };
}
async function notifyNewAlerts(host, s, settings, activatedAtS, nowS = Date.now() / 1000) {
  let state = states.get(settings);
  if (!state) {
    state = { since: settings.settingsReady === false ? activatedAtS : Math.max(settings.lastAlertAt, activatedAtS - 300), delivered: new Set((settings.deliveredAlerts ?? []).map((a) => JSON.stringify([a.key, a.at]))), pending: new Map, lastSent: -Infinity };
    states.set(settings, state);
  }
  const level = settings.notifications ?? "important";
  if (level === "off") {
    state.pending.clear();
    return settings.lastAlertAt;
  }
  const important = (a) => a.notification?.kind === "broken" || ["failed", "done"].includes(a.notification?.kind ?? "") && a.notification?.fromPanel === true || a.notification?.kind === "quota" && a.notification.executor === "claude-code";
  for (const a of s.alerts)
    if (a.at > Math.max(state.since, settings.lastAlertAt) && !state.delivered.has(id(a))) {
      if (level === "all" || important(a))
        state.pending.set(id(a), a);
    }
  if (nowS - state.lastSent < 5)
    return settings.lastAlertAt;
  const pending = [...state.pending.values()].sort((a, b) => a.at - b.at);
  const a = pending[0];
  const batched = a?.notification?.kind === "failed" || a?.notification?.kind === "broken";
  if (batched && nowS - a.at < 30)
    return settings.lastAlertAt;
  if (!a)
    return settings.lastAlertAt;
  const batch = batched ? pending.filter((x) => x.notification?.kind === a.notification?.kind && x.notification?.executor === a.notification?.executor && Math.abs(x.at - a.at) <= 30) : [a];
  const message = notificationMessage(a);
  if (batch.length > 1) {
    message.title = a.notification?.kind === "broken" ? `${executorName(a.notification.executor)} isn't starting` : `${batch.length} tasks failed on ${executorName(a.notification?.executor)}`;
    message.body = `${a.notification?.kind === "broken" ? `${batch.length} tasks affected` : shortGoal(a.notification?.goal ?? "")}
${a.notification?.nextExecutor ? `Moved to ${executorName(a.notification.nextExecutor)} automatically.` : "Open the pacer panel to retry."}`;
  }
  const delivered = await deliverNotification(host, message, nowS);
  if (!delivered)
    return settings.lastAlertAt;
  state.lastSent = nowS;
  for (const item of batch) {
    state.pending.delete(id(item));
    state.delivered.add(id(item));
  }
  settings.deliveredAlerts = [...settings.deliveredAlerts ?? [], ...batch.map((x) => ({ key: x.key, at: x.at }))].slice(-200);
  await host.call("settings.set", { key: "deliveredAlerts", value: settings.deliveredAlerts });
  const newest = Math.max(settings.lastAlertAt, ...batch.map((x) => x.at));
  settings.lastAlertAt = state.pending.size ? Math.min(newest, Math.min(...[...state.pending.values()].map((x) => x.at)) - 0.001) : newest;
  await host.call("settings.set", { key: "lastAlertAt", value: settings.lastAlertAt });
  return settings.lastAlertAt;
}

// orca-plugin/src/panel/shared.ts
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function jsonForScript(v) {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
var h = (v) => escapeHtml(String(v ?? ""));
var time = (at) => new Date(at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
function duration(seconds, long = false) {
  const minutes = Math.max(0, Math.floor(seconds / 60)), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (long)
    return days ? `${days} ${days === 1 ? "day" : "days"} ${hours % 24} ${hours % 24 === 1 ? "hour" : "hours"}` : `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return days ? `${days}d ${hours % 24}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
var backIn = (at, now) => at === null ? "reset unknown" : `back in ${duration(at - now)}`;
var age = (at, now) => `${duration(now - at)} ago`;
function packPanelData(value) {
  if (typeof value === "string" && value.length >= 32) {
    const runs = [];
    for (const char of value) {
      const last = runs.at(-1);
      if (last?.[0] === char)
        last[1]++;
      else
        runs.push([char, 1]);
    }
    const packed = { $runs: runs };
    return JSON.stringify(packed).length < JSON.stringify(value).length ? packed : value;
  }
  if (Array.isArray(value))
    return value.map(packPanelData);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, packPanelData(v)]));
  return value;
}
var actionStatus = '<p data-status role="status" aria-live="polite" class="action-status"></p>';

// orca-plugin/src/panel/icons.ts
var paths = { "claude-code": "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z", cursor: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23", agy: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81", byteplus: "M19.8772 1.4685L24 2.5326v18.9426l-4.1228 1.0563V1.4685zm-13.3481 9.428l4.115 1.0641v8.9786l-4.115 1.0642v-11.107zM0 2.572l4.115 1.0642v16.7354L0 21.428V2.572zm17.4553 5.6205v11.107l-4.1228-1.0642V9.2568l4.1228-1.0642z", local: "M14.025 0c3.492 0 5.237 0 6.571.68a6.24 6.24 0 0 1 2.725 2.724C24 4.738 24 6.484 24 9.975v4.05c0 3.492 0 5.237-.68 6.571a6.24 6.24 0 0 1-2.724 2.725c-1.334.679-3.08.679-6.571.679h-4.05c-3.492 0-5.237 0-6.571-.68A6.24 6.24 0 0 1 .68 20.597C0 19.262 0 17.516 0 14.025v-4.05c0-3.492 0-5.237.68-6.571A6.23 6.23 0 0 1 3.404.68C4.738 0 6.484 0 9.975 0zM7.688 16.313a1.313 1.313 0 0 0 0 2.625h11.625a1.313 1.313 0 0 0 0-2.625zm-3-3.75a1.313 1.313 0 0 0 0 2.624h11.625a1.313 1.313 0 0 0 0-2.624zm3-3.75a1.313 1.313 0 0 0 0 2.624h11.625a1.313 1.313 0 0 0 0-2.624zm-3-3.75a1.313 1.313 0 0 0 0 2.625h11.625a1.313 1.313 0 0 0 0-2.625z" };
var names = { "claude-code": "Claude", codex: "Codex", cursor: "Cursor", agy: "Antigravity", byteplus: "BytePlus", local: "Local model", opencode: "OpenCode" };
var displayName = (id) => Object.hasOwn(names, id) ? names[id] : id;
function icon(id, size = 16) {
  const name = escapeHtml(displayName(id));
  return Object.hasOwn(paths, id) ? `<svg role="img" aria-label="${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="${paths[id]}"></path></svg>` : `<span class="monogram" role="img" aria-label="${name}" style="width:${size}px;height:${size}px">${escapeHtml(id === "codex" ? "Cx" : id.slice(0, 2))}</span>`;
}
var mark = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><rect x="4" y="20" width="40" height="8" rx="4" fill="var(--border)"></rect><rect x="4" y="20" width="22" height="8" rx="4" fill="currentColor"></rect><rect class="brand-tick" x="29" y="12" width="4" height="24" rx="2"></rect></svg>`;
var info = `<svg role="img" aria-label="Information" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="flex-shrink:0"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v6M12 7v1"></path></svg>`;

// orca-plugin/src/panel/model.ts
function initialView(s, reachable, now) {
  return reachable && s.budget && [...s.consoles ?? [], ...s.console ? [s.console] : []].some((c) => c.handle && now - c.heartbeatAt <= 30) ? "overview" : "setup";
}
var words = { ON_PACE: "Available", OK: "Available", UNMETERED: "Available", AHEAD: "Ahead of pace", BEHIND: "Behind pace", EXPIRING: "Expiring soon", EXPIRING_SOON: "Expiring soon", NEAR_LIMIT: "Near limit", EXHAUSTED: "Out of quota" };
var verdictWords = (v) => Object.hasOwn(words, v) ? words[v] : "Unknown";
var tone = (v) => v === "EXHAUSTED" ? "bad" : ["AHEAD", "NEAR_LIMIT", "EXPIRING", "EXPIRING_SOON"].includes(v) ? "warn" : ["OK", "ON_PACE", "BEHIND", "UNMETERED"].includes(v) ? "good" : "neutral";
function rankedProviders(s) {
  const b = s.budget;
  return (b?.ranked ?? []).filter((r, i, a) => r.id !== b?.planner && a.findIndex((x) => x.id === r.id) === i).map((r) => b?.providers.find((p) => p.id === r.id) ?? { ...r, usedPct: null, pacePct: null, resetsAt: null, window: null, stale: false }).filter((p) => p.verdict !== "EXHAUSTED" && !p.brokenReason && !p.blockedReason);
}
function mutedProviders(s) {
  const ids = new Set(rankedProviders(s).map((p) => p.id));
  return (s.budget?.providers ?? []).filter((p) => p.id !== s.budget?.planner && !ids.has(p.id));
}
function headline(p, _now = 0) {
  switch (p?.verdict) {
    case "OK":
    case "ON_PACE":
      return "You're on pace for the week.";
    case "AHEAD":
    case "NEAR_LIMIT":
      return "Claude is ahead of pace. Slow down planning.";
    case "BEHIND":
      return "Claude is behind pace. Room for more planning.";
    case "EXHAUSTED":
      return p.resetsAt === null ? "Claude is out of quota until its next reset." : `Claude is out until ${new Date(p.resetsAt * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}.`;
    default:
      return "Budget unknown.";
  }
}
function answerDetail(s, now) {
  const p = s.budget?.providers.find((p) => p.id === s.budget?.planner), top = rankedProviders(s)[0];
  const parts = [];
  if (p?.usedPct != null)
    parts.push(`${displayName(p.id)} has ${Math.round(100 - p.usedPct)}% left${p.resetsAt == null ? "" : ` with ${duration(p.resetsAt - now, true)} to go`}.`);
  else if (p?.resetsAt != null)
    parts.push(`${displayName(p.id)} has ${duration(p.resetsAt - now, true)} to go.`);
  if (top)
    parts.push(`New work goes to ${displayName(top.id)}.`);
  return parts.join(" ");
}
function providerDetail(p, now) {
  if (p.brokenReason)
    return `Not working · ${p.brokenReason}`;
  if (p.blockedReason)
    return "Blocked by you";
  if (p.usedPct !== null)
    return `${Math.round(p.usedPct)}%${p.window ? ` of ${p.window}` : ""} used${p.resetsAt === null ? "" : ` · resets in ${duration(p.resetsAt - now)}`}${p.stale ? " · stale" : ""}`;
  if (p.id === "local")
    return "LM Studio · unmetered";
  return p.verdict === "UNKNOWN" ? "No budget reported" : "No limit reported";
}
function attentionGroups(s, now) {
  const groups = new Map;
  const resolved = new Set(s.tasks.filter((t) => t.state === "done" && t.retryOf).map((t) => t.retryOf));
  for (const t of [...s.tasks].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (t.dismissed || t.retriedBy && s.tasks.some((retry) => retry.id === t.retriedBy && ["queued", "running", "done"].includes(retry.state)) || resolved.has(t.id) || now - t.updatedAt > 3 * 86400)
      continue;
    if (!["failed", "limit"].includes(t.state) && !(["running", "queued"].includes(t.state) && !t.executor && !t.attemptStartedAt && !t.runnerAlive && now - t.updatedAt > 600))
      continue;
    const key = t.brokenExecutor ? `broken:${t.brokenExecutor}` : t.goal;
    groups.set(key, [...groups.get(key) ?? [], t]);
  }
  return [...groups].map(([_key, tasks]) => ({ goal: tasks[0].brokenExecutor ? `${displayName(tasks[0].brokenExecutor)} is not working` : tasks[0].goal, tasks, latest: tasks[0], stuck: ["running", "queued"].includes(tasks[0].state), retry: rankedProviders(s).find((p) => !tasks.some((t) => t.executor === p.id)) ?? null, ...tasks[0].brokenExecutor ? { brokenExecutor: tasks[0].brokenExecutor, brokenReason: tasks[0].brokenReason } : {} }));
}
function attentionText(g, now) {
  if (g.brokenExecutor)
    return `${displayName(g.brokenExecutor)} is not working: ${g.brokenReason ?? "CLI startup failed"} · ${g.tasks.length} tasks affected`;
  if (g.stuck)
    return `Waiting ${duration(now - g.latest.updatedAt)} with no executor picked`;
  const count = g.tasks.length, label = g.latest.state === "limit" ? "Hit a limit" : "Failed";
  return `${label}${count === 2 ? " twice" : count > 2 ? ` ×${count}` : ""}${g.latest.executor ? ` on ${displayName(g.latest.executor)}` : ""}`;
}
var unavailableDetail = (p, now) => p.blockedReason ? "Blocked by you" : p.brokenReason ? `Not working · ${p.brokenReason}` : p.verdict === "EXHAUSTED" ? `out of quota · ${backIn(p.resetsAt, now)}` : "not in the queue";

// orca-plugin/src/panel/overview.ts
function meter(p, slim = false) {
  if (p.usedPct === null)
    return "";
  const used = Math.max(0, Math.min(100, p.usedPct)), pace = p.pacePct == null ? null : Math.max(0, Math.min(100, p.pacePct));
  return `<div class="meter ${slim ? "slim" : ""} ${tone(p.verdict)}" role="progressbar" aria-label="${h(displayName(p.id))} usage${pace === null ? "" : `, pace ${pace}%`}" aria-valuenow="${used}" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:${used}%"></div>${pace === null ? "" : `<div class="pace" style="left:${pace}%"></div>`}</div>`;
}
function connectionIndicator(s, now, reachable) {
  const old = now - (s.budget?.generatedAt ?? s.at) > 120;
  return `<span class="name live ${reachable ? old ? "warn" : "good" : "bad"}"><span class="dot"></span><span data-freshness>${reachable ? `Live · ${h(time(s.budget?.generatedAt ?? s.at))}` : "Not connected"}</span></span>`;
}
function header(s, now, reachable) {
  return `<header><span class="brand name">${mark}pacer</span>${s.budget ? `<span class="pill">${h((s.mode?.mode ?? s.budget.mode).replace(/^./, (c) => c.toUpperCase()))} mode</span>` : ""}<span class="grow"></span>${connectionIndicator(s, now, reachable)}</header>`;
}
function strategyPicker(_s) {
  return `<section id="strategy-picker" hidden></section>`;
}
function overview(s, now, reachable, commands, text) {
  const p = s.budget?.providers.find((p) => p.id === s.budget?.planner), attention = attentionGroups(s, now);
  return `<div class="content">${header(s, now, reachable)}
 <div class="card stack answer"><div class="stack"><div class="headline">${h(headline(p, now))}</div><div class="muted">${h(answerDetail(s, now))}</div></div>${p ? `<div class="stack"><div class="row"><span class="name">${icon(p.id, 14)}${h(displayName(p.id))}</span><small>planner</small><span class="grow"></span><span class="percent">${p.usedPct === null ? "—" : `${Math.round(p.usedPct)}%`}</span><small>used</small></div>${meter(p)}<div class="row"><small>Pace marker ${p.pacePct == null ? "—" : `${p.pacePct}%`}</small><span class="grow"></span><small>${p.resetsAt === null ? "Reset unknown" : `Resets ${h(new Date(p.resetsAt * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }))}`}</small></div></div>` : ""}</div>
 <section class="stack section"><div class="row"><h2>Who runs next</h2><span class="grow"></span><small>in this order</small></div><div class="list" id="ranked-list"></div><div class="stack unavailable" id="unavailable-list"></div></section>
 <section class="stack section"><div class="row"><h2>Needs attention</h2>${attention.length ? `<span class="pill bad">${attention.length}</span>` : ""}</div>${attention.slice(0, 10).map((g, i) => {
    const key = `attention-${i}`;
    text[key + "-goal"] = g.goal.length > 96 ? g.goal.slice(0, 93) + "…" : g.goal;
    text[key + "-detail"] = attentionText(g, now) + (g.stuck ? "" : ` · ${age(g.latest.updatedAt, now)}`);
    if (g.retry)
      text[key + "-executor"] = displayName(g.retry.id);
    if (g.stuck && /^[A-Za-z0-9_-]{1,128}$/.test(g.latest.id))
      commands[key] = { cmd: "stop", taskId: g.latest.id };
    else if (g.retry && /^[A-Za-z0-9_-]{1,128}$/.test(g.latest.id) && /^[a-z0-9-]{1,64}$/.test(g.retry.id))
      commands[key] = g.brokenExecutor ? { cmd: "retry-all", taskIds: g.tasks.map((t) => t.id), executor: g.retry.id } : { cmd: "retry", taskId: g.latest.id, executor: g.retry.id };
    if (!g.stuck)
      commands[key + "-dismiss"] = { cmd: "dismiss", ...g.tasks.length > 1 ? { taskIds: g.tasks.map((t) => t.id) } : { taskId: g.latest.id } };
    return `<div class="card stack attention ${g.stuck ? "stuck" : ""}"><div class="row"><span class="${g.stuck ? "warn" : "bad"}" aria-hidden="true">${g.stuck ? "◐" : "✕"}</span><div class="stack grow"><span class="task-goal"><span data-text="${key}-goal"></span></span><small><span data-text="${key}-detail"></span></small></div></div><div class="actions">${commands[key] ? `<button type="button" class="${g.stuck ? "" : "primary"}" data-command="${key}">${g.stuck ? "Stop it" : `${g.brokenExecutor ? "Retry all" : "Retry"} on <span data-text="${key}-executor"></span>`}</button>` : "<small>No other executor available.</small>"}${!g.stuck ? `<button type="button" data-command="${key}-dismiss">Dismiss</button>` : ""}</div></div>`;
  }).join("")}${attention.length > 10 ? `<small>${attention.length - 10} more groups need attention. View all with pacer tasks.</small>` : ""}${attention.length ? "" : "<small>Nothing needs attention.</small>"}</section>
 <section class="stack section"><h2>Running</h2>${s.tasks.filter((t) => ["running", "queued"].includes(t.state)).map((t) => `<div class="card stack"><span>${h(t.goal)}</span><small>${t.executor ? `Running on ${h(displayName(t.executor))} · started <span data-age-at="${t.attemptStartedAt ?? t.updatedAt}">${Math.max(0, Math.floor(now - (t.attemptStartedAt ?? t.updatedAt)))}s ago</span>` : "Queued"}${t.retryOf ? ` · Retry of ${h(t.retryOf)}` : ""}</small></div>`).join("") || "<small>No tasks running.</small>"}</section>
 <section class="stack section"><h2>Recently done</h2><div class="stack recent">${[...s.tasks].filter((t) => t.state === "done").sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3).map((t) => `<div class="row"><span class="good" aria-hidden="true">✓</span><div class="stack grow"><span class="ellipsis" title="${h(t.goal.slice(0, 100))}">${h(t.goal.slice(0, 100))}</span><small>${h(t.executor ? displayName(t.executor) : "—")} · ${h(age(t.updatedAt, now))}</small></div></div>`).join("")}${s.tasks.some((t) => t.state === "done") ? "" : "<small>No completed tasks yet.</small>"}</div></section>
 ${strategyPicker(s)}</div><div class="actionbar"><div class="actions"><button type="button" class="primary grow" data-view="delegate" data-live>Delegate a task</button><button type="button" data-view="strategy" data-live>Strategy</button><button type="button" class="refresh" data-command="refresh" aria-label="Refresh">↻</button></div>${actionStatus}<div class="footnote">Updated <span data-updated>—</span> · <span data-console-connection>Checking console...</span></div></div>`;
}

// orca-plugin/src/panel/setup.ts
function setup(s, now, reachable) {
  const consoleLive = !!liveConsole(s, now), planner = s.budget?.providers.find((p) => p.id === s.budget?.planner);
  const step = (n, done, title, detail, command) => `<div class="step ${done ? "done" : n === 1 || reachable ? "current" : ""}"><span class="step-num" aria-hidden="true">${done ? "✓" : n}</span><div class="stack grow"><strong>${title}</strong><small>${detail}</small>${command ? `<div class="row command"><code class="grow">${command}</code><button type="button" data-setup="${command}">Type command</button></div>` : ""}</div></div>`;
  return `<div class="content">${header(s, now, reachable)}<div class="stack"><div class="headline">Connect pacer</div><div class="muted">The plugin is on. It needs pacer running on this machine to show your budget and send work.</div></div><div class="list">${step(1, reachable, s.serviceInstalled ? "pacer link is restarting" : "Start pacer in the background", s.serviceInstalled ? "pacer runs as a background service and restarts on its own within a few seconds. If it stays down, run:" : "Installs pacer as a login service so this panel always connects.", s.serviceInstalled ? "pacer service restart" : "pacer service install")}${step(2, consoleLive, "Open the pacer console", "Lets the buttons here delegate and switch strategy. Runs in this worktree.", "pacer console --open")}</div>${!s.budget && reachable ? "<small>Waiting for the first budget snapshot. Check again after pacer refreshes.</small>" : ""}${planner ? `<section class="stack section"><h2>Last known budget · ${h(age(s.budget.generatedAt, now))} · not live</h2><div class="card stack last-known"><div class="row"><span class="name">${icon(planner.id)}${h(displayName(planner.id))}</span><span class="grow"></span><strong>${planner.usedPct === null ? "—" : `${Math.round(planner.usedPct)}%`} used</strong></div>${meter({ ...planner, pacePct: null })}<small>Shown greyed until pacer reconnects. Nothing here is live.</small></div></section>` : ""}<div class="row note info"><strong aria-hidden="true">i</strong><small>pacer never changes Orca's settings. Everything runs on 127.0.0.1 and only on this machine.</small></div></div><div class="actionbar"><div class="actions"><button type="button" class="primary grow" disabled>Delegate a task</button><button type="button" data-check>Check again</button></div>${actionStatus}<div class="footnote">Delegating needs the console from step 2</div></div>`;
}

// orca-plugin/src/panel/delegate.ts
function delegateView(s, now, reachable) {
  return `<div id="delegate-form" role="group"><div class="content"><header><button type="button" data-view="overview" aria-label="Back to overview">←</button><strong>Delegate a task</strong><span class="grow"></span>${connectionIndicator(s, now, reachable)}</header><div class="muted">Write it the way you'd brief a colleague who can't see this chat. Claude plans; the task runs on an executor.</div><div class="stack"><label for="goal">What should be done?</label><textarea id="goal" name="goal" maxlength="2000" rows="5" placeholder="e.g. Make the owner-facing diag calls accept browser_turn_id, with a regression test"></textarea></div><div class="stack"><strong>Where</strong><div class="stack where"><strong data-worktree>—</strong><small>Branch <span id="worktree-branch">—</span> · focused worktree</small></div></div><div class="stack"><label for="done">Done when</label><input id="done" name="acceptance" type="text" maxlength="500" placeholder="A command that passes, e.g. bun test"><small>pacer runs it after the executor finishes and only reports done if it passes.</small></div><fieldset class="stack"><legend>Runs on</legend><label class="radio"><input type="radio" name="executor" value="" checked><span class="stack grow"><strong>Best available</strong><small><span id="ranked-order"></span></small></span><span class="pill">Recommended</span></label><div id="executor-options" class="stack"></div></fieldset><div class="row note"><strong aria-hidden="true">i</strong><small>Runs in its own worktree. You'll get a notification when it finishes, and it shows under Needs attention if it fails.</small></div></div><div class="actionbar"><div class="actions"><button type="button" data-view="overview">Cancel</button><button type="button" id="delegate-send" class="primary grow" data-live>Delegate</button></div>${actionStatus}</div></div>`;
}

// orca-plugin/src/panel/style.ts
var style = `
.action-spinner{display:inline-block;animation:console-spin 1s linear infinite}@media(prefers-reduced-motion:reduce){.action-spinner{animation:none}}
.action-status{margin:4px 0;color:var(--muted-foreground);white-space:pre-wrap;overflow-wrap:anywhere}.action-status:empty{display:none}

.console-spinner{display:inline-block;animation:console-spin 1s linear infinite}@keyframes console-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.console-spinner{animation:none}}

*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font-size:12px;font-family:var(--app-font-family,'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);line-height:1.4;letter-spacing:.01em;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;--good:color-mix(in srgb,seagreen 90%,var(--background));--warn:color-mix(in srgb,darkorange 90%,var(--background));--bad:color-mix(in srgb,crimson 90%,var(--background))}[hidden]{display:none!important}.view{min-height:100vh;display:flex;flex-direction:column}form{display:flex;flex-direction:column;flex:1}.content{padding:12px;display:flex;flex-direction:column;gap:12px;flex:1;min-width:0}.row,.name,header,.actions{display:flex;align-items:center;gap:8px}.grow{flex:1;min-width:0}.stack{display:flex;flex-direction:column;gap:6px;min-width:0}.brand{font-weight:600;font-size:14px;letter-spacing:.01em}.brand-tick{fill:#65A30D}@media(prefers-color-scheme:dark){.brand-tick{fill:#A3E635}body{--good:color-mix(in srgb,mediumseagreen 90%,var(--background));--warn:color-mix(in srgb,orange 90%,var(--background));--bad:color-mix(in srgb,lightcoral 90%,var(--background))}}.muted,small{color:var(--muted-foreground)}small{font-size:11px}.pill{font-size:10px;font-weight:500;padding:2px 6px;border-radius:6px;background:var(--muted);white-space:nowrap}.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}.pill.good{background:color-mix(in srgb,green 12%,var(--background))}.pill.warn{background:color-mix(in srgb,orange 16%,var(--background))}.pill.bad{background:color-mix(in srgb,crimson 12%,var(--background))}.dot{width:8px;height:8px;border-radius:50%;background:currentColor}.live{font-size:11px;white-space:nowrap}.card,.list{border:1px solid var(--border);border-radius:calc(var(--radius,10px) - 2px);background:var(--card)}.answer{padding:12px;gap:8px}.headline{font-size:13px;font-weight:600}h2{font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:500;margin:0;color:var(--muted-foreground)}.section{gap:8px}.provider{padding:8px 10px;gap:6px}.provider+.provider,.step+.step{border-top:1px solid var(--border)}.rank{width:18px;height:18px;flex-shrink:0;background:var(--muted);border-radius:6px;display:grid;place-items:center;font-size:11px;font-weight:600}.provider:first-child .rank{background:var(--foreground);color:var(--background)}.name{font-weight:500;gap:6px;overflow-wrap:anywhere}.name svg,.monogram{flex-shrink:0}.monogram{border-radius:4px;background:var(--foreground);color:var(--background);display:inline-flex;align-items:center;justify-content:center;font-size:8px;font-weight:600}.meter{position:relative;height:6px;background:var(--border);border-radius:999px;margin:4px 0}.meter.slim{height:3px;margin-left:26px}.meter .fill{height:100%;border-radius:999px;background:currentColor}.pace{position:absolute;width:2px;top:-4px;bottom:-4px;background:var(--foreground);border-radius:2px}.percent{font-size:18px;font-weight:600}.unavailable{font-size:11px;padding:0 4px;gap:4px}.attention{padding:10px;gap:8px;border-color:color-mix(in srgb,crimson 25%,var(--background));background:color-mix(in srgb,crimson 2%,var(--card))}.attention.stuck{border-color:color-mix(in srgb,orange 35%,var(--background));background:color-mix(in srgb,orange 3%,var(--card))}.task-goal{font-weight:500;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.recent{gap:8px}button,input,textarea,select{font:inherit;color:var(--foreground)}button{white-space:nowrap;flex-shrink:0;min-height:28px;padding:0 10px;border:1px solid var(--border);border-radius:calc(var(--radius,10px) - 2px);background:var(--background);cursor:pointer}button.primary{min-height:32px;background:var(--primary);color:var(--background);font-weight:500;border-color:var(--primary)}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--primary);outline-offset:2px}.actionbar{position:sticky;bottom:0;padding:8px 12px 10px;border-top:1px solid var(--border);background:var(--background);display:flex;flex-direction:column;gap:8px}.actionbar button,.actionbar button.primary{height:32px;min-height:32px}.actionbar .refresh{width:32px;min-width:32px;padding:0}.footnote{font-size:11px;text-align:center;color:var(--muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#status{margin:0;padding:0 12px 8px;color:var(--muted-foreground);white-space:pre-wrap;overflow-wrap:anywhere}#status:empty{display:none}.step{padding:10px;display:flex;gap:8px}.step-num{width:22px;height:22px;border:2px solid var(--border);border-radius:50%;display:grid;place-items:center;flex-shrink:0;font-size:11px;font-weight:600}.step.done .step-num{background:var(--good);border-color:var(--good);color:var(--background)}.step.current .step-num{border-color:var(--foreground)}.command,.where{padding:6px 6px 6px 10px;border-radius:calc(var(--radius,10px) - 2px);background:var(--muted)}code{font:11px ui-monospace,monospace;overflow-wrap:anywhere}.last-known{padding:10px;border-style:dashed;color:var(--muted-foreground)}.last-known .fill{background:var(--muted-foreground)}.note{padding:10px;background:var(--muted);border-radius:calc(var(--radius,10px) - 2px);color:var(--muted-foreground)}.note.info{background:color-mix(in srgb,dodgerblue 9%,var(--background))}textarea,input[type=text]{background:var(--background);border:1px solid var(--border);border-radius:calc(var(--radius,10px) - 2px);padding:6px 10px;width:100%}textarea{resize:vertical}input[type=text]{min-height:28px}strong,label,legend{font-weight:500}header>strong{font-weight:600}.where{padding:8px 10px}fieldset{border:0;padding:0;margin:0;min-width:0}legend{margin-bottom:6px}.radio{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:calc(var(--radius,10px) - 2px);font-weight:400;cursor:pointer;min-height:32px}.radio:has(input:checked){outline:1px solid var(--foreground);border-color:var(--foreground)}.radio:has(input:disabled){color:var(--muted-foreground);cursor:default}.radio input{margin:0;width:14px;height:14px}.radio strong{font-weight:500}
select{height:28px;background:var(--background);border:1px solid var(--border);border-radius:8px;padding:0 8px;min-width:0}.strategy-list{overflow:hidden}.strategy-list button{width:100%;border:0;border-radius:0;padding:8px 10px;text-align:left}.strategy-list button+button{border-top:1px solid var(--border)}.strategy-list small{white-space:normal}.strategy-builder{padding:12px;gap:10px;flex:0;background:var(--muted)}.strategy-saved{padding:10px;background:color-mix(in srgb,green 3%,var(--card));border-color:color-mix(in srgb,green 25%,var(--background))}
`;

// orca-plugin/src/panel/strategy.ts
function strategyView(s, now, reachable) {
  const agents = ["claude-code", "codex"].filter((id) => id === s.budget?.planner || s.budget?.providers.some((p) => p.id === id));
  return `<div class="content"><header><button type="button" data-view="overview" aria-label="Back to overview">←</button><strong>Strategy</strong><span class="grow"></span>${connectionIndicator(s, now, reachable)}</header>
 <section class="stack"><label>Notifications<select id="notification-level"><option value="important">Important</option><option value="all">All</option><option value="off">Off</option></select></label></section>
 <section class="stack"><h2>Switch to</h2><div class="list strategy-list" id="strategy-list"></div></section>
 <div id="strategy-form" role="group" class="card stack strategy-builder"><strong>Build a new strategy with an agent</strong><small>Describe what you want. The agent drafts it, shows how routing would change, and asks before saving.</small>
 <label for="strategy-brief">What should it do?</label><textarea id="strategy-brief" rows="4" maxlength="2000" placeholder="e.g. Protect Claude this week. Burn Codex before it resets on Sunday."></textarea>
 <div class="row"><label class="stack grow">Start from<select id="strategy-from"></select></label><label class="stack grow">Agent<select id="strategy-agent">${agents.map((id) => `<option value="${id}"${id === s.budget?.planner ? " selected" : ""}>${id === "claude-code" ? "Claude Code" : "Codex"}${id === s.budget?.planner ? " (planner)" : ""}</option>`).join("")}</select></label></div>
 <div class="note row">${info}<small>Opens a new terminal in this worktree with the agent already briefed. You chat with it there; nothing changes until you approve the save. Switching stays a separate click here.</small></div></div>
 <section id="strategy-after" class="stack" hidden></section></div><div class="actionbar"><div class="actions"><button type="button" data-view="overview">Done</button><button type="button" id="strategy-send" class="primary grow" data-live${agents.length ? "" : " disabled"}>Start session</button></div>${actionStatus}</div>`;
}

// orca-plugin/src/panel/pending.ts
var pendingClient = `
const actionStorage="pacer-pending-actions";
let actionStates={};
try {const saved=JSON.parse(sessionStorage.getItem(actionStorage)||"{}");if(saved && !Array.isArray(saved))actionStates=saved;}catch{}
const actionButtons=new Map();
function saveActions(){try{sessionStorage.setItem(actionStorage,JSON.stringify(actionStates));}catch{}}
function actionKey(c){return c.cmd+":"+(c.taskId||c.taskIds?.join(",")||c.executor||c.strategy||c.goal||c.from||c.text||"");}
function actionLabel(c){const name=providerNames[c.executor]||c.executor||"executor";return ({retry:"Retrying on "+name+"...","retry-all":"Retrying all on "+name+"...",stop:"Stopping...",dismiss:"Dismissing...",delegate:"Delegating...","strategy-build":"Starting session...",use:"Switching...",block:"Blocking...",unblock:"Unblocking...",refresh:"Refreshing...",type:"Typing command..."})[c.cmd]||"Working...";}
function outcome(a){
 const c=a.action,t=data.tasks||[],ids=c.taskIds||[c.taskId],p=[...data.rows,...data.muted].find(p=>p.id===c.executor);
 if(c.cmd==="retry"||c.cmd==="retry-all")return ids.every(id=>t.some(x=>x.retryOf===id)||t.find(x=>x.id===id)?.retriedBy);
 if(c.cmd==="stop")return ids.every(id=>t.some(x=>x.id===id&&!["queued","running"].includes(x.state)));
 if(c.cmd==="dismiss")return ids.every(id=>!t.some(x=>x.id===id)||t.find(x=>x.id===id)?.dismissed);
 if(c.cmd==="delegate")return t.some(x=>!a.known.includes(x.id)&&(x.goal===c.goal||x.goal===c.goal.slice(0,197)+"..."));
 if(c.cmd==="block"||c.cmd==="unblock")return p && !!p.blocked===(c.cmd==="block");
 if(c.cmd==="use")return data.strategy===c.strategy;
 if(c.cmd==="strategy-build")return data.buildAlert && data.buildAlert.at>=a.startedAt;
 if(c.cmd==="refresh")return data.sequence>a.sequence;
 if(c.cmd==="type")return a.accepted;
 return false;
}
function restoreAction(key){const entry=actionButtons.get(key);if(entry){entry.button.disabled=entry.disabled;entry.button.innerHTML=entry.html;entry.card?.removeAttribute?.("aria-busy");}actionButtons.delete(key);delete actionStates[key];saveActions();}
function paintAction(key,button){
 const a=actionStates[key];if(!a)return;
 if(!actionButtons.has(key))actionButtons.set(key,{button,disabled:button.disabled,html:button.innerHTML,card:button.closest?.(".card,.row,.actionbar")});
 button.disabled=true;button.innerHTML='<span class="action-spinner" aria-hidden="true">◐</span> '+h(actionLabel(a.action));
 actionButtons.get(key).card?.setAttribute?.("aria-busy","true");
}
function beginAction(button,action){
 const key=actionKey(action);if(actionStates[key]||button.disabled)return null;
 actionStates[key]={action,target:action.taskId||action.executor||action.strategy||"",startedAt:Date.now()/1000,known:(data.tasks||[]).map(t=>t.id),sequence:data.sequence};
 paintAction(key,button);saveActions();if(typeof setTimeout==="function")setTimeout(()=>recoverActions(),60000);return key;
}
function pendingSend(button,command,after,workspace){
 const key=beginAction(button,command);if(!key)return false;
 return sendCommand(command,value=>{if(actionStates[key]){actionStates[key].accepted=true;saveActions();}if(after)after(value);},()=>{restoreAction(key);if(!status.textContent)status.textContent="The console could not accept this action. Try again.";const card=button.closest?.(".card,.row,.actionbar");if(card?.insertAdjacentHTML)card.insertAdjacentHTML("beforeend",'<p role="alert" class="action-error">The console could not accept this action. Try again.</p>');},workspace);
}
function recoverActions(){
 for(const [key,a] of Object.entries(actionStates)){
  if(!a||typeof a.startedAt!=="number"||!a.action){delete actionStates[key];continue;}
  const rejection=(data.actionErrors||[]).find(e=>e.key==="retry-"+a.action.taskId&&e.at>=a.startedAt);
  if(rejection){restoreAction(key);status.textContent=rejection.body;continue;}
  if(outcome(a)){restoreAction(key);continue;}
  const button=actionButtons.get(key)?.button;
  if(Date.now()/1000-a.startedAt>=60){
   if(button){button.disabled=false;button.innerHTML=actionButtons.get(key).html;}
   restoreAction(key);
   status.textContent="Still waiting for the pacer console. Check the pacer tab in this worktree.";
  }else if(button)paintAction(key,button);
 }
 saveActions();
}
function bindAction(button,action){const key=actionKey(action);if(actionStates[key]){if(outcome(actionStates[key]))restoreAction(key);else paintAction(key,button);}}
`;

// orca-plugin/src/panel/client.ts
var client = `
const embedded = JSON.parse(document.getElementById("pacer-actions").textContent);
function unpack(value) {
 if(Array.isArray(value)) return value.map(unpack);
 if(value && typeof value === "object") return Object.hasOwn(value,"$runs") ? value.$runs.map(([c,n])=>c.repeat(n)).join("") : Object.fromEntries(Object.entries(value).map(([k,v])=>[k,unpack(v)]));
 return value;
}
const data = unpack(embedded.encoded ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(embedded.encoded), c=>c.charCodeAt(0)))) : embedded);
const providerNames = {"claude-code":"Claude",codex:"Codex",cursor:"Cursor",agy:"Antigravity",byteplus:"BytePlus",local:"Local model",opencode:"OpenCode"};
for (const p of [...data.rows,...data.muted]) p.name = Object.hasOwn(providerNames,p.id) ? providerNames[p.id] : p.id;
data.executors = data.rows.map(p=>p.id);
const statusNode = document.getElementById("status");
const status = { get textContent() { return statusNode.textContent; }, set textContent(value) {
 statusNode.textContent = value;
 for (const el of document.querySelectorAll("[data-status]")) el.textContent = value;
} };
if(data.buildAlert) status.textContent=data.buildAlert.title+(data.buildAlert.body?": "+data.buildAlert.body:"");
const sentAt = [], pending = new Map();
let sequence = 0, context = null, sending = false;
const submitButton = document.getElementById("delegate-send");
function finishSending() { sending = false; submitButton.disabled = false; }
function show(view) {
  if(view === "strategy" && savedStrategy) {try {sessionStorage.setItem("pacer-seen-strategies",JSON.stringify([...seenStrategies,savedStrategy.key+":"+savedStrategy.at].slice(-100)));}catch {}}
  for (const el of document.querySelectorAll("[data-page]")) el.hidden = el.dataset.page !== view;
  status.textContent = "";
}
function live(workspace) {
  const available = data.consoles.filter(c=>c.handle && c.live);
  const selected = workspace === undefined ? available[0] : available.find(c=>Array.isArray(workspace?.terminals) && workspace.terminals.some(t=>t.id===c.handle));
  if (selected) { if(workspace !== undefined) data.handle = selected.handle; document.getElementById("console-hint").hidden = true; return true; }
  status.textContent = workspace !== undefined && Array.isArray(workspace?.terminals) && workspace.terminals.some(t=>typeof t.title === "string" && /^pacer(?: console)?$/.test(t.title)) ? "Reopen the panel to connect to the new console." : data.autoConsole ? "The pacer console for this worktree is starting. Try again in a few seconds." : "Start the console first.";
  document.getElementById("console-hint").hidden = false;
  return false;
}
function updateFreshness() {
  for(const el of document.querySelectorAll("[data-age-at]"))el.textContent=Math.max(0,Math.floor(Date.now()/1000-Number(el.dataset.ageAt)))+"s ago";
  for(const el of document.querySelectorAll("[data-updated]")) el.textContent = data.updatedAt ? new Date(data.updatedAt*1000).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",hour12:false}) : "—";
  const old = Date.now()/1000-data.snapshotAt>120;
  for(const el of document.querySelectorAll("[data-freshness]")) {
    // Unchanged data is not re-rendered (Orca reloads the panel on every write), so age alone is not a fault: show it neutrally.
    el.parentElement.className = "name live " + (!data.reachable ? "bad" : old ? "muted" : "good");
    el.textContent = !data.reachable ? "Not connected" : (old ? "Updated " : "Live · ") + new Date(data.snapshotAt*1000).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",hour12:false});
  }
}
updateFreshness(); setInterval(()=>{updateFreshness();recoverActions();},30000);
function request(action, params, purpose, after, onFailure) {
  const now = Date.now();
  while (sentAt.length && now - sentAt[0] >= 10000) sentAt.shift();
  if (sentAt.length >= 30) { status.textContent = "Please wait before sending another command."; return false; }
  const requestId = "pacer-" + (++sequence), message = {type:"orca-panel-action",requestId,action,params};
  if (new TextEncoder().encode(JSON.stringify(message)).length > 65536) { status.textContent = "Panel message exceeds 64 KiB."; return false; }
  pending.set(requestId,{purpose,after,onFailure}); sentAt.push(now);
  window.parent.postMessage(message,"*"); return true;
}
function readContext(after, onFailure) { return request("workspace.readContext",{},"context",after,onFailure); }
function sendCommand(command, after, onFailure, workspace) {
  const fail = () => { if(onFailure) onFailure(); return false; };
  if (Object.values(command).some(value => typeof value === "string" && /[\\x7f-\\x9f]/.test(value))) { status.textContent = "Input contains unsupported control characters."; return fail(); }
  if (!live()) return fail();
  const send = value => {
    updateContext(value);
    if (!live(value)) return fail();
    const text = ": pacer '" + JSON.stringify({v:1,type:"cmd",data:command}).replace(/'/g,"\\\\u0027") + "'";
    if (text.length > 4096) { status.textContent = "pacer command line exceeds 4096 characters. Shorten your brief and try again."; return fail(); }
    if (!request("terminal.sendText",{terminalId:data.handle,text,enter:true},"console",after,onFailure)) return fail();
    return true;
  };
  if (workspace !== undefined) return send(workspace);
  if (!readContext(send,onFailure)) return fail();
  return true;
}
${pendingClient}
function updateContext(value) {
  context = value && typeof value.branch === "string" && typeof value.displayName === "string" ? value : null;
  for (const el of document.querySelectorAll("[data-worktree]")) el.textContent = context ? context.displayName : "—";
  document.getElementById("worktree-branch").textContent = context ? context.branch : "—";
  const connected = context && data.consoles.some(c=>c.live && Array.isArray(context.terminals) && context.terminals.some(t=>t.id===c.handle));
  for (const el of document.querySelectorAll("[data-console-connection]")) el.textContent = context ? (connected ? "console connected in " : "console not connected in ") + context.displayName : "console not connected";
}
// Escape data before creating local provider rows; the same nodes populate the radio list.
function h(value) { return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
for (const el of document.querySelectorAll("[data-text]")) el.innerHTML = h(data.text[el.dataset.text]);
const strategyEntries=data.strategies.map(e=>typeof e === "string"?{name:e,summary:"",active:e===data.strategy}:e);
document.getElementById("strategy-list").innerHTML=strategyEntries.map((e,i)=>'<button type="button" class="row" data-strategy="'+i+'"'+(e.active?' disabled title="This strategy is already active."':'')+'><span>'+(e.active?'✓':'')+'</span><span class="stack grow"><strong>'+h(e.name)+'</strong><small>'+h(e.summary)+'</small></span>'+(e.active?'<span class="pill">Active</span>':'')+'</button>').join("");
document.getElementById("strategy-from").innerHTML=strategyEntries.map(e=>'<option value="'+h(e.name)+'"'+(e.active?' selected':'')+'>'+h(e.name)+'</option>').join("");
for(const b of document.querySelectorAll("[data-strategy]")) {const entry=strategyEntries[Number(b.dataset.strategy)];if(!entry)continue;const command={cmd:"use",strategy:entry.name};bindAction(b,command);b.addEventListener("click",()=>pendingSend(b,command));}
let seenStrategies=[];
try { seenStrategies=JSON.parse(sessionStorage.getItem("pacer-seen-strategies") || "[]"); if(!Array.isArray(seenStrategies))seenStrategies=[]; } catch {}
const savedStrategy=(data.savedAlerts || []).find(a=>!seenStrategies.includes(a.key+":"+a.at));
const afterSession=document.getElementById("strategy-after");
if(savedStrategy) {
 afterSession.hidden=false;
 afterSession.innerHTML='<h2>After the session</h2><div class="card row strategy-saved"><span class="good">✓</span><div class="stack grow"><strong>'+h(savedStrategy.title)+'</strong><small>'+h(savedStrategy.body)+'</small></div><button type="button" data-saved-switch>Switch</button></div>';
 document.querySelector("[data-saved-switch]")?.addEventListener("click",event=>pendingSend(event.currentTarget,{cmd:"use",strategy:savedStrategy.key.slice("strategySaved-".length)}));
}
document.getElementById("ranked-order").innerHTML = h(data.rows.map(p=>p.name).join(" → ") || "No executor available");
function icon(p,size) {
  return Object.hasOwn(data.paths,p.id) ? '<svg role="img" aria-label="'+h(p.name)+'" width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="currentColor"><path d="'+data.paths[p.id]+'"></path></svg>' : '<span class="monogram" role="img" aria-label="'+h(p.name)+'" style="width:'+size+'px;height:'+size+'px">'+h(p.id === "codex" ? "Cx" : p.id.slice(0,2))+'</span>';
}
function meter(p) {
 if(p.usedPct===null) return "";
 const used=Math.max(0,Math.min(100,p.usedPct)), pace=p.pacePct===null?null:Math.max(0,Math.min(100,p.pacePct));
 return '<div class="meter slim '+p.tone+'" role="progressbar" aria-label="'+h(p.name)+' usage" aria-valuenow="'+used+'" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:'+used+'%"></div>'+(pace===null?'':'<div class="pace" style="left:'+pace+'%"></div>')+'</div>';
}
const rankedList = document.getElementById("ranked-list"), mutedList = document.getElementById("unavailable-list"), options = document.getElementById("executor-options");
rankedList.innerHTML = data.rows.map((p,i) => '<div class="stack provider"><div class="row"><span class="rank">'+(i+1)+'</span><div class="stack grow"><span class="name">'+icon(p,14)+h(p.name)+'</span><small>'+h(p.detail)+'</small></div><span class="pill '+p.tone+'">'+h(p.words)+'</span><button type="button" data-executor-action="'+i+'">Block</button></div>'+meter(p)+'</div>').join("") || '<div class="provider muted">No executor available yet.</div>';
mutedList.innerHTML = data.muted.map((p,i)=>'<div class="row"><span class="name">'+icon(p,13)+h(p.name)+'</span><span>'+h(p.detail)+'</span><button type="button" data-executor-action="'+(data.rows.length+i)+'">'+(p.blocked?'Unblock':'Block')+'</button></div>').join("");
options.innerHTML = data.rows.map((p,i)=>'<label class="radio"><input type="radio" name="executor" value="'+i+'"><span class="stack grow"><span class="name">'+icon(p,14)+h(p.name)+'</span><small>'+h(p.detail)+'</small></span><span class="pill '+p.tone+'">'+h(p.words)+'</span></label>').join("") + data.muted.filter(p=>p.verdict === "EXHAUSTED").map(p=>'<label class="radio"><input type="radio" name="executor" value="unavailable" disabled><span class="stack grow"><span class="name">'+icon(p,14)+h(p.name)+'</span><small>'+h(p.detail)+'</small></span></label>').join("");
for(const b of document.querySelectorAll("[data-executor-action]")) {
 const provider=[...data.rows,...data.muted][Number(b.dataset.executorAction)];if(provider)bindAction(b,{cmd:provider.blocked?"unblock":"block",executor:provider.id});
 b.addEventListener("click",()=>{
 const p=[...data.rows,...data.muted][Number(b.dataset.executorAction)];
 if(p && /^[a-z0-9-]{1,64}$/.test(p.id))pendingSend(b,{cmd:p.blocked?"unblock":"block",executor:p.id});
});}
for (const b of document.querySelectorAll("[data-view]")) b.addEventListener("click", () => {
  if (["delegate","strategy"].includes(b.dataset.view)) {
    if (!live()) return;
    readContext(value => { updateContext(value); if(!live(value)) return; show(b.dataset.view); document.getElementById(b.dataset.view === "delegate" ? "goal" : "strategy-brief").focus(); });
  } else show(b.dataset.view);
});
for (const b of document.querySelectorAll("[data-command]")) {
 if(data.commands[b.dataset.command])bindAction(b,data.commands[b.dataset.command]);
 b.addEventListener("click", () => {
  const command = data.commands[b.dataset.command];
  if (command) pendingSend(b,command); else status.textContent = "Reopen the panel to load this action.";
});
}
for (const b of document.querySelectorAll("[data-setup]")) {bindAction(b,{cmd:"type",text:b.dataset.setup});b.addEventListener("click", () => {
  const key=beginAction(b,{cmd:"type",text:b.dataset.setup});if(!key)return;
  readContext(value => {
    updateContext(value);
    const terminal = context && Array.isArray(context.terminals) && context.terminals[0];
    if (!terminal || typeof terminal.id !== "string") { status.textContent = "Open a terminal in this worktree first"; restoreAction(key);return; }
    request("terminal.sendText",{terminalId:terminal.id,text:b.dataset.setup,enter:false},"setup",()=>restoreAction(key),()=>restoreAction(key));
  },()=>restoreAction(key));
});}
for (const b of document.querySelectorAll("[data-check]")) b.addEventListener("click", () => {
  if (!data.reachable) {
    status.textContent = "Waiting for pacer serve. Start it, then reopen this panel.";
    document.getElementById("console-hint").hidden = true;
    return;
  }
  pendingSend(b,{cmd:"refresh"});
});
document.getElementById("delegate-send").addEventListener("click", () => {
  if (sending) { status.textContent = "A command is already being sent. Please wait."; return; }
  if (!live()) return;
  const goal = document.getElementById("goal").value, acceptance = document.getElementById("done").value;
  const selected = document.querySelector('input[name="executor"]:checked');
  if (!goal.trim()) { status.textContent = "What should be done is required."; return; }
  if (goal.length > 2000 || acceptance.length > 500) { status.textContent = "Goal must be at most 2000 characters; Done when at most 500."; return; }
  if (!selected || selected.disabled || selected.value && (!data.executors[Number(selected.value)] || !/^[a-z0-9-]{1,64}$/.test(data.executors[Number(selected.value)]))) { status.textContent = "Choose an available executor."; return; }
  const command={cmd:"delegate",goal,acceptance,...(selected.value?{executor:data.executors[Number(selected.value)]}:{})};
  const action=beginAction(submitButton,command);if(!action)return;
  sending = true;
  const failDelegate=()=>{restoreAction(action);finishSending();};
  if (!readContext(value => {
    updateContext(value);
    if (!context || !context.branch) { status.textContent = "Focus a worktree first."; failDelegate(); return; }
    if (!sendCommand({cmd:"delegate",branch:context.branch,displayName:context.displayName,...(typeof context.worktreeId === "string" && context.worktreeId ? {worktreeId:context.worktreeId} : {}),goal,acceptance,...(selected.value?{executor:data.executors[Number(selected.value)]}:{})}, () => {
      document.getElementById("goal").value = "";
      document.getElementById("done").value = "";
      document.querySelector('input[name="executor"][value=""]').checked = true;
      sending=false; show("overview");
      status.textContent = "Sent. The task id appears in the pacer console.";
    }, failDelegate, value)) failDelegate();
  }, failDelegate)) failDelegate();
});
document.getElementById("strategy-send").addEventListener("click", () => { if(sending){status.textContent="A command is already being sent. Please wait.";return;} if(!live())return;
 const brief=document.getElementById("strategy-brief").value, from=document.getElementById("strategy-from").value, agent=document.getElementById("strategy-agent").value;
 if(!brief.trim() || brief.length>2000 || !["claude-code","codex"].includes(agent)) {status.textContent="Enter a brief of at most 2000 characters and choose a configured agent.";return;}
 const button=document.getElementById("strategy-send");const action=beginAction(button,{cmd:"strategy-build",agent,from,brief});if(!action)return;sending=true;
 const finish=()=>{sending=false;restoreAction(action);};
 if(!readContext(value=>{updateContext(value);if(!context || !context.branch){status.textContent="Focus a worktree first.";finish();return;}
 sendCommand({cmd:"strategy-build",agent,from,brief,branch:context.branch,...(context.worktreeId?{worktreeId:context.worktreeId}:{})},()=>{sending=false;status.textContent="Sent to the pacer console. Watch the new terminal.";},finish,value);
 },finish))finish();
});
document.getElementById("done").addEventListener("keydown", event => {
 if(event.key === "Enter") {event.preventDefault();document.getElementById("delegate-send").click();}
});
window.addEventListener("message", event => {
  const r = event.data;
  if (event.source !== window.parent || !r || r.type !== "orca-panel-action-result" || !pending.has(r.requestId)) return;
  const item = pending.get(r.requestId); pending.delete(r.requestId);
  if (!r.ok) { status.textContent = typeof r.error === "string" ? r.error : "Orca refused this request."; if (item.onFailure) item.onFailure(); return; }
  if(item.purpose==="notification-settings"){if(item.after)item.after(r.value);return;}
  if (item.purpose === "context") { updateContext(r.value); if (item.after) item.after(r.value); return; }
  const accepted = r.value && r.value.accepted;
  status.textContent = accepted ? item.purpose === "setup" ? "Typed into your terminal. Press Enter to run it." : "Sent to pacer console" : "Orca refused to type into the terminal.";
  if (accepted && item.after) item.after(r.value);
  if (!accepted && item.onFailure) item.onFailure();
});
for(const a of Object.values(actionStates)) {
 if(a.action?.cmd==="delegate")bindAction(submitButton,a.action);
 if(a.action?.cmd==="strategy-build")bindAction(document.getElementById("strategy-send"),a.action);
}
const notificationControl=document.getElementById("notification-level");
if(notificationControl){request("settings.get",undefined,"notification-settings",value=>{const level=value?.settings?.notifications;if(["off","important","all"].includes(level))notificationControl.value=level;});notificationControl.addEventListener("change",()=>{request("settings.set",{key:"notifications",value:notificationControl.value},"notification-settings",()=>{status.textContent="Notification preference saved.";});});}
recoverActions();
try {const saved=Number(sessionStorage.getItem("pacer-panel-scroll"));if(Number.isFinite(saved)&&saved>=0)window.scrollTo?.(0,saved);}catch{}
window.addEventListener("scroll",()=>{try{sessionStorage.setItem("pacer-panel-scroll",String(window.scrollY));}catch{}},{passive:true});
readContext(value => { live(value); });
`;

// orca-plugin/src/panel.ts
function renderPanel(s, view) {
  const reconnecting = !view.reachable && !!s.budget && view.lastSeenAt !== undefined && view.nowS - view.lastSeenAt >= 0 && view.nowS - view.lastSeenAt < 20;
  const consoles = [...s.consoles ?? [], ...s.console ? [s.console] : []].filter((c) => c.handle && view.nowS - c.heartbeatAt <= LIMITS.heartbeatS).filter((c, i, a) => a.findIndex((x) => x.handle === c.handle) === i), console = consoles[0], selected = reconnecting ? "overview" : initialView(s, view.reachable, view.nowS);
  const commands = { refresh: { cmd: "refresh" } };
  const text = {};
  const main = overview(s, view.nowS, view.reachable, commands, text);
  const reasonText = view.autoConsole ?? true ? "The pacer console for this worktree is starting. Try again in a few seconds." : "Start the console first.";
  const disable = (html) => (console ? html : html.replace(/(data-command="[^"]+"|data-live)(?=[ >])/g, "$1 disabled")).replace(/<button([^>]*\bdisabled[^>]*)>([\s\S]*?)<\/button>/g, (_match, attrs, label) => `<button${attrs} title="${h(reasonText)}">${label}</button><small class="muted">${h(reasonText)}</small>`);
  const payload = { actionErrors: s.alerts.filter((a) => a.key.startsWith("retry-") && a.level !== "info").map((a) => ({ key: a.key, at: a.at, body: a.body })), sequence: s.seq, tasks: s.tasks.map((t) => ({ id: t.id, state: t.state, goal: t.goal, retryOf: t.retryOf, retriedBy: t.retriedBy, dismissed: t.dismissed })), autoConsole: view.autoConsole ?? true, buildAlert: s.alerts.find((a) => a.key === "strategy-build") ?? null, consoles: consoles.map((c) => ({ handle: c.handle, live: true })), strategies: s.strategies?.length ? s.strategies : [s.budget?.strategy ?? "default"], strategy: s.budget?.strategy ?? "default", savedAlerts: s.alerts.filter((a) => a.key.startsWith("strategySaved-")), snapshotAt: s.budget?.generatedAt ?? s.at, updatedAt: s.at, reachable: view.reachable, commands, text, paths: Object.fromEntries(Object.entries(paths).filter(([id]) => [...rankedProviders(s), ...mutedProviders(s)].some((p) => p.id === id))), rows: rankedProviders(s).map((p) => ({ id: p.id, usedPct: p.usedPct, pacePct: p.pacePct, detail: providerDetail(p, view.nowS), tone: tone(p.verdict), words: verdictWords(p.verdict), blocked: false })), muted: mutedProviders(s).map((p) => ({ id: p.id, verdict: p.verdict, detail: unavailableDetail(p, view.nowS), blocked: !!p.blockedReason })) };
  const strategy = strategyView(s, view.nowS, view.reachable);
  const outcome = view.autoConsoleOutcome, waiting = !outcome || outcome.status === "starting" && view.nowS - outcome.at < 15;
  const reason = outcome ? outcome.status === "older-console" ? "An older pacer console is running here; it restarts automatically after updates. A fresh console is starting." : outcome.status === "starting" ? "Console startup is taking longer than expected." : `Auto-open: ${outcome.status}.` : "Press Enter in the terminal to start it.";
  const consoleHint = waiting && view.transport === "http" && (view.autoConsole ?? true) && view.reachable ? `<small class="muted"><span class="console-spinner" aria-hidden="true">◐</span> Starting pacer console in this worktree...</small>` : `<button type="button" data-setup="pacer console">Start console</button><small>${h(reason)}</small>`;
  const packed = packPanelData(payload), plain = jsonForScript(packed), encoded = jsonForScript({ encoded: Buffer.from(JSON.stringify(packed), "utf8").toString("base64") });
  const data = encoded.length < plain.length ? encoded : plain;
  return `<!doctype html><html lang="en" data-transport="${h(view.transport ?? "none")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><title>pacer budget</title><style>${style}</style></head><body>
 <main class="view" data-page="overview"${selected === "overview" ? "" : " hidden"}>${reconnecting ? '<div role="status" class="note">Reconnecting...</div><div style="opacity:.45;pointer-events:none" inert>' + disable(main) + "</div>" : disable(main)}</main>
 <main class="view" data-page="setup"${selected === "setup" ? "" : " hidden"}>${setup(s, view.nowS, view.reachable)}</main>
 <main class="view" data-page="delegate" hidden>${disable(delegateView(s, view.nowS, view.reachable))}</main>
 <main class="view" data-page="strategy" hidden>${disable(strategy)}</main>
 <p id="status" role="status" aria-live="polite"></p><div id="console-hint" class="note stack" hidden><strong>No pacer console in this worktree</strong>${consoleHint}</div>
 <script type="application/json" id="pacer-actions">${data}</script><script>
${client}</script></body></html>`;
}

// orca-plugin/src/plugin.ts
function createPlugin(deps) {
  let stopped = false;
  let stopWatch = null;
  let cancelRender = null;
  let cancelRetry = null;
  const timerCancels = new Set;
  const timers = {
    every(ms, fn) {
      const cancel = deps.timers.every(ms, fn);
      timerCancels.add(cancel);
      return () => {
        cancel();
        timerCancels.delete(cancel);
      };
    },
    after(ms, fn) {
      let cancel;
      cancel = deps.timers.after(ms, () => {
        timerCancels.delete(cancel);
        fn();
      });
      timerCancels.add(cancel);
      return () => {
        cancel();
        timerCancels.delete(cancel);
      };
    }
  };
  async function activate(ctx) {
    stopped = false;
    const activatedAtS = deps.nowS();
    let raw = {};
    let settingsReady = false;
    let cancelSettings = () => {};
    try {
      const result = await Promise.race([
        ctx.host.call("settings.get").then((result) => {
          settingsReady = true;
          return result;
        }),
        new Promise((resolve) => {
          cancelSettings = timers.after(500, () => resolve({ settings: {} }));
        })
      ]);
      raw = result.settings;
    } catch {} finally {
      cancelSettings();
    }
    if (stopped)
      return;
    const settings = readSettings(raw, deps.home);
    settings.settingsReady = settingsReady;
    timers.every(1e4, () => {
      ctx.host.call("settings.get").then((result) => {
        settings.lastAlertAt = Math.max(settings.lastAlertAt, readSettings(result.settings, deps.home).lastAlertAt);
        settings.deliveredAlerts = [...settings.deliveredAlerts ?? [], ...readSettings(result.settings, deps.home).deliveredAlerts ?? []].slice(-200);
        settings.notifications = readSettings(result.settings, deps.home).notifications;
        settings.settingsReady = true;
      }).catch(() => {});
    });
    const store = new LinkStore(deps.nowS);
    const bridge = bridgeTransport({ host: ctx.host, pollMs: settings.pollSeconds * 1000, timers });
    const transports = [
      httpTransport({ http: deps.http, readToken: () => deps.fs.readText(`${settings.pacerHome}/token`)?.trim() || null, port: settings.port, timers }),
      channelTransport({ host: ctx.host, registerEvent: (name, handler) => ctx.events.on(name, async (payload) => {
        await ensureConnected();
        if (!stopped)
          handler(payload);
      }) }),
      bridge
    ];
    let active = null, reachable = false, connecting = null;
    let lastSeenAt;
    const reconnecting = () => !reachable && lastSeenAt !== undefined && deps.nowS() - lastSeenAt < 20;
    let processing = Promise.resolve();
    let httpFailures = 0;
    let renderedKey = null;
    let lastRenderAt = -Infinity;
    let userOutcome = false;
    const outcomes = new Map;
    let focusedWorktree = null, attempted = false;
    const panelOutcome = () => (focusedWorktree ? outcomes.get(focusedWorktree) : undefined) ?? { status: "starting", at: activatedAtS };
    const hintKey = () => {
      if (!settings.autoConsole || active?.id !== "http" || !reachable)
        return null;
      const outcome = focusedWorktree ? outcomes.get(focusedWorktree) : undefined;
      const hasLive = [...store.snapshot.consoles ?? [], ...store.snapshot.console ? [store.snapshot.console] : []].some((c) => c.handle && deps.nowS() - c.heartbeatAt <= LIMITS.heartbeatS);
      if ((outcome?.status === "registered" || !outcome) && hasLive)
        return null;
      const current = panelOutcome();
      return { ...current, expired: current.status === "starting" && deps.nowS() - current.at >= 15 };
    };
    const panelKey = () => JSON.stringify({
      budget: store.snapshot.budget ? { ...store.snapshot.budget, generatedAt: undefined } : null,
      mode: store.snapshot.mode ? { ...store.snapshot.mode, at: undefined } : null,
      serviceInstalled: store.snapshot.serviceInstalled,
      reconnecting: reconnecting(),
      tasks: store.snapshot.tasks.map(({ updatedAt, ...task }) => task),
      alerts: store.snapshot.alerts,
      consoles: [...new Set([...(store.snapshot.consoles ?? []).map((c) => c.handle), store.snapshot.console?.handle].filter(Boolean))].sort().map((handle) => ({
        handle,
        live: [...store.snapshot.consoles ?? [], ...store.snapshot.console ? [store.snapshot.console] : []].some((c) => c.handle === handle && deps.nowS() - c.heartbeatAt <= LIMITS.heartbeatS)
      })),
      autoConsoleOutcome: hintKey(),
      strategies: store.snapshot.strategies,
      transport: store.transport,
      reachable
    });
    const logError = (e) => ctx.log(`pacer: ${e instanceof Error ? e.message : String(e)}`);
    const scheduleRender = (immediate = false) => {
      if (immediate) {
        userOutcome = true;
        cancelRender?.();
        cancelRender = null;
      }
      if (stopped || cancelRender)
        return;
      cancelRender = timers.after(Math.max(200, (lastRenderAt + (userOutcome ? 2 : 10) - deps.nowS()) * 1000), () => {
        cancelRender = null;
        if (stopped)
          return;
        try {
          const key = panelKey(), nowS = deps.nowS();
          if (key !== renderedKey) {
            if (deps.fs.exists(join(deps.pluginRoot, ".pacer-managed"))) {
              deps.fs.writeTextAtomic(join(deps.pluginRoot, "panel", "live.html"), renderPanel(store.snapshot, { nowS, transport: store.transport, reachable, lastSeenAt, autoConsole: settings.autoConsole, autoConsoleOutcome: panelOutcome() }));
              renderedKey = key;
              lastRenderAt = nowS;
              userOutcome = false;
            } else
              ctx.log("pacer: refused panel write: unmanaged root");
          }
        } catch (e) {
          logError(e);
        }
        const snapshot = store.snapshot;
        processing = processing.then(async () => {
          if (!stopped)
            await notifyNewAlerts(ctx.host, snapshot, settings, activatedAtS, deps.nowS());
        }).catch(logError);
      });
    };
    store.onChange(() => scheduleRender());
    timers.every(1000, () => {
      processing = processing.then(async () => {
        if (!stopped)
          await notifyNewAlerts(ctx.host, store.snapshot, settings, activatedAtS, deps.nowS());
      }).catch(logError);
    });
    timers.every(15000, () => {
      if (panelKey() !== renderedKey)
        scheduleRender();
    });
    const replaceSnapshot = (snapshot) => {
      if (stopped)
        return;
      const previous = store.snapshot;
      const consoleChanged = !!snapshot.console?.handle !== !!previous.console?.handle;
      const initiated = consoleChanged || snapshot.budget?.strategy !== previous.budget?.strategy || snapshot.tasks.some((t) => !previous.tasks.some((p) => p.id === t.id) || t.dismissed !== previous.tasks.find((p) => p.id === t.id)?.dismissed || t.retriedBy !== previous.tasks.find((p) => p.id === t.id)?.retriedBy) || snapshot.alerts.some((a) => a.key === "strategy-build" && !previous.alerts.some((p) => p.key === a.key && p.at === a.at)) || snapshot.budget?.providers.some((p) => p.blockedReason !== previous.budget?.providers.find((x) => x.id === p.id)?.blockedReason);
      if (initiated) {
        userOutcome = true;
        if (cancelRender) {
          cancelRender();
          cancelRender = null;
        }
      }
      store.replace(snapshot);
    };
    const acceptSnapshot = (snapshot) => {
      if (stopped)
        return;
      httpFailures = 0;
      lastSeenAt = deps.nowS();
      if (!reachable) {
        reachable = true;
        scheduleRender(true);
      }
      replaceSnapshot(snapshot);
    };
    const connect = async () => {
      const chosen = await chooseTransport(transports, settings.transport);
      if (stopped)
        return;
      active = chosen.transport;
      reachable = chosen.reachable && active?.id !== "bridge";
      if (reachable)
        lastSeenAt = deps.nowS();
      store.transport = active?.id ?? null;
      if (!active) {
        scheduleRender();
        cancelRetry = timers.after(settings.pollSeconds * 1000, () => {
          cancelRetry = null;
          ensureConnected();
        });
        return;
      }
      const snapshot = await active.snapshot().catch(() => null) ?? await bridge.snapshot();
      if (stopped)
        return;
      if (snapshot)
        replaceSnapshot(snapshot);
      stopWatch = active.watch((e) => {
        if (!stopped) {
          lastSeenAt = deps.nowS();
          store.apply(e);
        }
      }, active.id === "bridge" ? replaceSnapshot : acceptSnapshot, () => {
        handleHttpFailure().catch(logError);
      });
      scheduleRender();
    };
    function ensureConnected() {
      if (stopped || stopWatch)
        return Promise.resolve();
      if (!connecting) {
        cancelRetry?.();
        cancelRetry = null;
        connecting = connect().catch(logError).finally(() => {
          connecting = null;
        });
      }
      return connecting;
    }
    const notify = async (title, body) => {
      try {
        if (settings.notifications !== "all")
          return;
        const plain = title.startsWith("pacer ") && !title.includes("console") ? "Budget refreshed" : title.replace(/\bpacer\b\s*/gi, "");
        await deliverNotification(ctx.host, { title: clip(plain, 60), body: body?.startsWith("terminal ") ? "Nothing to do." : title.startsWith("pacer ") && !title.includes("console") ? "Open the pacer panel for the current budget." : clip(body ?? "Nothing to do.", 1000) }, deps.nowS());
      } catch (e) {
        logError(e);
      }
    };
    const handleHttpFailure = async () => {
      const failures = ++httpFailures;
      const snapshot = await bridge.snapshot();
      if (snapshot)
        replaceSnapshot(snapshot);
      if (stopped || active?.id !== "http")
        return;
      reachable = false;
      if (lastSeenAt !== undefined)
        timers.after(Math.max(0, (20 - (deps.nowS() - lastSeenAt)) * 1000), scheduleRender);
      if (failures >= 3) {
        stopWatch?.();
        stopWatch = null;
        httpFailures = 0;
        await ensureConnected();
      }
      scheduleRender();
    };
    const refreshSnapshot = async () => {
      try {
        const snapshot = await active?.snapshot().catch(() => null);
        if (snapshot) {
          if (active?.id === "bridge")
            replaceSnapshot(snapshot);
          else
            acceptSnapshot(snapshot);
        } else if (active?.id === "http")
          await handleHttpFailure();
        else {
          const fallback = await bridge.snapshot();
          if (fallback)
            replaceSnapshot(fallback);
        }
      } catch (e) {
        logError(e);
      }
    };
    let probing = false;
    timers.every(settings.pollSeconds * 1000, () => {
      if (stopped || probing || connecting || active?.id === "http")
        return;
      probing = true;
      (async () => {
        if (active?.id === "channel")
          await refreshSnapshot();
        if (stopped || settings.transport !== "auto")
          return;
        const chosen = await chooseTransport(transports, settings.transport);
        if (stopped || chosen.transport?.id === active?.id)
          return;
        stopWatch?.();
        stopWatch = null;
        await ensureConnected();
      })().catch(logError).finally(() => {
        probing = false;
      });
    });
    const failureLogged = new Map;
    let opening = false;
    timers.every(5000, () => {
      if (stopped || opening || !settings.autoConsole || active?.id !== "http" || !reachable)
        return;
      opening = true;
      let worktree = "unknown";
      (async () => {
        const context = await ctx.host.call("workspace.readContext");
        if (stopped)
          return;
        if (!context || !context.branch) {
          focusedWorktree = null;
          attempted = false;
          scheduleRender();
          return;
        }
        worktree = context.worktreeId || context.branch;
        if (focusedWorktree !== worktree) {
          focusedWorktree = worktree;
          attempted = false;
          outcomes.delete(worktree);
          scheduleRender(true);
        }
        const now = deps.nowS(), ids = new Set(context.terminals.map((t) => t.id));
        if ([...store.snapshot.consoles ?? [], ...store.snapshot.console ? [store.snapshot.console] : []].some((c) => c.handle && ids.has(c.handle) && now - c.heartbeatAt <= LIMITS.heartbeatS)) {
          if (outcomes.get(worktree)?.status !== "registered") {
            outcomes.set(worktree, { status: "registered", at: now });
            scheduleRender(true);
          }
          return;
        }
        if (attempted) {
          const outcome = outcomes.get(worktree);
          if (outcome?.status === "registered" || outcome?.status === "starting" && now - outcome.at >= 30) {
            outcomes.set(worktree, { status: "gave-up", at: now });
            scheduleRender(true);
          }
          return;
        }
        attempted = true;
        outcomes.set(worktree, { status: "starting", at: now });
        scheduleRender(true);
        const base = `http://127.0.0.1:${settings.port}`;
        const health = await deps.http.get(`${base}/health`, "", 1500);
        if (stopped || active?.id !== "http")
          return;
        if (health.status !== 200 || health.headers?.["x-pacer"] !== "1")
          throw new Error("unidentified HTTP listener");
        const token = deps.fs.readText(`${settings.pacerHome}/token`)?.trim();
        if (!token || !deps.http.post)
          throw new Error("HTTP console opening unavailable");
        const response = await deps.http.post(`${base}/console/open`, token, { ...context.terminals[0] ? { terminal: context.terminals[0].id } : {}, branch: context.branch }, 1500);
        if (response.headers?.["x-pacer"] !== "1")
          throw new Error(`HTTP ${response.status}`);
        const result = JSON.parse(response.body);
        if (!result.ok) {
          outcomes.set(worktree, { status: typeof result.reason === "string" ? result.reason : "orca-unavailable", at: deps.nowS() });
          scheduleRender(true);
        } else if (result.warning === "older-console") {
          outcomes.set(worktree, { status: "older-console", at: deps.nowS() });
          scheduleRender(true);
        } else if (response.status !== 200 && !(response.status === 202 && result.queued === true))
          throw new Error(`HTTP ${response.status}`);
      })().catch((e) => {
        const now = deps.nowS();
        outcomes.set(worktree, { status: "orca-unavailable", at: now });
        scheduleRender(true);
        if (now - (failureLogged.get(worktree) ?? -Infinity) >= 300) {
          failureLogged.set(worktree, now);
          ctx.log(`pacer: auto console in ${worktree}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }).finally(() => {
        opening = false;
      });
    });
    const sendFresh = async (data) => {
      await refreshSnapshot();
      if (stopped)
        return "no-console";
      return sendToConsole(ctx.host, store.snapshot, data, deps.nowS());
    };
    const send = async (data) => {
      const result = await sendFresh(data);
      if (result === "no-console") {
        await notify(NO_CONSOLE.title, NO_CONSOLE.body);
        return { ok: false, message: NO_CONSOLE.title };
      }
      if (result === "rejected") {
        const message = "Orca refused to type into the pacer console";
        await notify(message, "Focus the console's worktree and retry, or run `pacer console --open` here.");
        return { ok: false, message };
      }
      const message = "Sent to pacer console";
      await notify(message);
      return { ok: true, message };
    };
    ctx.commands.register("delegate", async () => {
      await ensureConnected();
      let context = null;
      try {
        context = await ctx.host.call("workspace.readContext");
      } catch (e) {
        logError(e);
      }
      return send({ cmd: "delegate", ...context ? { branch: context.branch, displayName: context.displayName, ...context.worktreeId ? { worktreeId: context.worktreeId } : {} } : {} });
    });
    ctx.commands.register("switch-strategy", async () => {
      await ensureConnected();
      return send({ cmd: "use" });
    });
    ctx.commands.register("refresh-status", async () => {
      await ensureConnected();
      const result = await sendFresh({ cmd: "refresh" });
      if (result === "rejected")
        await notify("Orca refused to type into the pacer console", "Focus the console's worktree and retry, or run `pacer console --open` here.");
      scheduleRender();
      const message = summaryLine(store.snapshot.budget);
      await notify(message, (store.snapshot.budget?.providers ?? []).map((p) => `${p.id} ${p.verdict} ${p.usedPct === null ? "?" : `${Math.round(p.usedPct)}%`}`).join(`
`));
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
    const paneLast = new Map;
    let lastDone = -Infinity;
    ctx.events.on("agent.status.changed", async (payload) => {
      await ensureConnected();
      if (!payload || typeof payload !== "object")
        return;
      const p = payload;
      if (p.state !== "done" || (p.mainAgent?.state ?? "done") !== "done" || typeof p.paneKey !== "string")
        return;
      await refreshSnapshot();
      const now = deps.nowS();
      if (stopped || now - lastDone < 5 || now - (paneLast.get(p.paneKey) ?? -Infinity) < 5 || !liveConsole(store.snapshot, now))
        return;
      lastDone = now;
      paneLast.set(p.paneKey, now);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await refreshSnapshot();
      await sendToConsole(ctx.host, store.snapshot, { cmd: "agent-done", paneKey: p.paneKey, ...typeof p.worktreeId === "string" ? { worktreeId: p.worktreeId } : {} }, now);
    });
    ctx.events.on("worktree.created", async (payload) => {
      await ensureConnected();
      if (!payload || typeof payload !== "object")
        return;
      const p = payload;
      if (typeof p.branch !== "string" || !/(^|\/)pacer-/.test(p.branch) || typeof p.worktreeId !== "string" || typeof p.path !== "string")
        return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await sendFresh({ cmd: "worktree-created", worktreeId: p.worktreeId, path: p.path, branch: p.branch });
    });
    ctx.events.on("worktree.removed", async (payload) => {
      if (stopped || !payload || typeof payload !== "object" || !("worktreeId" in payload))
        return;
      const id = payload.worktreeId;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}(?:::[^\x00-\x1f\x7f]{1,900})?$/.test(id))
        return;
      outcomes.delete(id);
      failureLogged.delete(id);
      if (focusedWorktree === id) {
        focusedWorktree = null;
        attempted = false;
      }
      scheduleRender();
      try {
        const base = `http://127.0.0.1:${settings.port}`;
        const health = await deps.http.get(`${base}/health`, "", 1500);
        if (stopped || health.status !== 200 || health.headers?.["x-pacer"] !== "1")
          return;
        const token = deps.fs.readText(`${settings.pacerHome}/token`)?.trim();
        if (!token || !deps.http.post)
          return;
        await deps.http.post(`${base}/console/forget`, token, { worktreeId: id }, 1500);
      } catch (e) {
        logError(e);
      }
    });
    try {
      ctx.host.call("events.subscribe", { events: ["agent.status.changed", "worktree.created", "worktree.removed"] }).catch(logError);
    } catch (e) {
      logError(e);
    }
    ensureConnected();
  }
  return {
    activate,
    async deactivate() {
      stopped = true;
      stopWatch?.();
      stopWatch = null;
      cancelRender?.();
      cancelRender = null;
      cancelRetry?.();
      cancelRetry = null;
      for (const cancel of timerCancels)
        cancel();
      timerCancels.clear();
    }
  };
}

// orca-plugin/src/worker.ts
var timers = {
  every(ms, fn) {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  },
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  }
};
function checkLoopback(url) {
  const u = new URL(url);
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || u.username || u.password)
    throw new Error("pacer worker only supports loopback HTTP");
}
var http = {
  post(url, token, data, timeoutMs) {
    return new Promise((resolve, reject) => {
      checkLoopback(url);
      const body = JSON.stringify(data);
      const req = request(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
        let response = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          response += chunk;
          if (Buffer.byteLength(response) > 256 * 1024)
            req.destroy(new Error("pacer response exceeds 256 KiB"));
        });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: response, headers: res.headers }));
      });
      const timeout = setTimeout(() => req.destroy(new Error("pacer HTTP timeout")), timeoutMs);
      req.on("close", () => clearTimeout(timeout));
      req.on("error", reject);
      req.end(body);
    });
  },
  get(url, token, timeoutMs) {
    return new Promise((resolve, reject) => {
      checkLoopback(url);
      const req = get(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          if (Buffer.byteLength(body) > 256 * 1024)
            req.destroy(new Error("pacer snapshot exceeds 256 KiB"));
        });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      const timeout = setTimeout(() => req.destroy(new Error("pacer HTTP timeout")), timeoutMs);
      req.on("close", () => clearTimeout(timeout));
      req.on("error", reject);
    });
  },
  stream(url, token, onLine, onClose) {
    checkLoopback(url);
    let stopped = false, closed = false;
    const close = (err) => {
      if (!stopped && !closed) {
        closed = true;
        onClose(err);
      }
    };
    const req = get(url, { headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        close(new Error(`pacer events HTTP ${res.statusCode}`));
        req.destroy();
        return;
      }
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (stopped)
          return;
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf(`
`)) >= 0) {
          onLine(buffer.slice(0, newline).replace(/\r$/, ""));
          buffer = buffer.slice(newline + 1);
        }
        if (Buffer.byteLength(buffer) > 256 * 1024)
          req.destroy(new Error("pacer SSE line exceeds 256 KiB"));
      });
      res.on("end", () => close());
      res.on("close", () => close());
      res.on("error", close);
    });
    req.on("error", close);
    return () => {
      stopped = true;
      req.destroy();
    };
  }
};
var pluginRoot = dirname(fileURLToPath(import.meta.url));
var log = (message) => {};
var plugin = createPlugin({
  nowS: () => Date.now() / 1000,
  timers,
  http,
  home: process.env.HOME ?? process.env.USERPROFILE ?? "",
  pluginRoot,
  fs: {
    readText(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    exists: existsSync,
    writeTextAtomic(path, text) {
      if (resolve(path) !== resolve(pluginRoot, "panel", "live.html") || !existsSync(join2(pluginRoot, ".pacer-managed"))) {
        log("pacer: refused panel write: unmanaged root or unexpected path");
        return;
      }
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, text, "utf8");
        renameSync(temporary, path);
      } finally {
        try {
          unlinkSync(temporary);
        } catch {}
      }
    }
  }
});
async function activate(ctx) {
  log = (message) => ctx.log(message);
  await plugin.activate(ctx);
}
async function deactivate() {
  await plugin.deactivate();
}
export {
  deactivate,
  activate as default
};
