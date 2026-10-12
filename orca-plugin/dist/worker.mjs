// orca-plugin/src/worker.ts
import { get } from "node:http";
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
    return [{ id, verdict, usedPct: num(p.usedPct), resetsAt: num(p.resetsAt), window: optStr(p.window, 32), stale: p.stale === true }];
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
  return { id, state, updatedAt, goal: str(d.goal, LIMITS.goal) ?? "", executor: optStr(d.executor, 64), backend: optStr(d.backend, 32), worktree: optStr(d.worktree, 4096) };
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
  return alert;
}
function parseConsole(d) {
  if (!isObj(d))
    return null;
  const pid = num(d.pid), startedAt = num(d.startedAt), heartbeatAt = num(d.heartbeatAt);
  if (pid === null || startedAt === null || heartbeatAt === null)
    return null;
  return { pid, startedAt, heartbeatAt, handle: optStr(d.handle, 1024), paneKey: optStr(d.paneKey, 2048) };
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
  return { v: 1, seq: 0, at: 0, budget: null, mode: null, tasks: [], alerts: [], console: null };
}
function parseSnapshot(raw) {
  if (!isObj(raw) || raw.v !== 1)
    return null;
  const seq = num(raw.seq), at = num(raw.at);
  if (seq === null || at === null)
    return null;
  const list = (v, f, max) => (Array.isArray(v) ? v : []).map(f).filter((x) => x !== null).slice(0, max);
  return { v: 1, seq, at, budget: raw.budget == null ? null : parseBudget(raw.budget), mode: raw.mode == null ? null : parseMode(raw.mode), tasks: list(raw.tasks, parseTask, LIMITS.tasks), alerts: list(raw.alerts, parseAlert, LIMITS.alerts), console: raw.console == null ? null : parseConsole(raw.console) };
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
  return JSON.stringify({ budget: s.budget ? { ...s.budget, generatedAt: undefined } : null, mode: s.mode, tasks: s.tasks, alerts: s.alerts, console: s.console });
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
    transport: ["auto", "http", "channel", "bridge"].includes(raw.transport) ? raw.transport : "auto",
    port: finite(raw.port) && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535 ? raw.port : 4317,
    pacerHome: typeof raw.pacerHome === "string" && raw.pacerHome.length > 0 ? raw.pacerHome : `${home}/.pacer`,
    pollSeconds: finite(raw.pollSeconds) ? Math.max(5, Math.min(300, raw.pollSeconds)) : 10,
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
      const cancel = o.timers.every(o.pollMs, () => {
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
async function sendToConsole(host, s, data, nowS) {
  const console = liveConsole(s, nowS);
  if (!console)
    return "no-console";
  try {
    return (await host.call("terminal.sendText", { terminalId: console.handle, text: encodeCmdLine(data), enter: true })).accepted ? "sent" : "rejected";
  } catch {
    return "rejected";
  }
}
var NO_CONSOLE = { title: "pacer console is not running", body: "Run `pacer console --open` (or start `pacer console` in an Orca terminal), then retry." };

// orca-plugin/src/notify.ts
var deliveryState = new WeakMap;
async function notifyNewAlerts(host, s, settings, activatedAtS) {
  let state = deliveryState.get(settings);
  if (!state) {
    state = { since: Math.max(settings.lastAlertAt, activatedAtS - 600), delivered: new Set };
    deliveryState.set(settings, state);
  }
  const id = (a) => JSON.stringify([a.at, a.key]);
  const alerts = s.alerts.filter((a) => a.at >= state.since && !state.delivered.has(id(a))).sort((a, b) => a.at - b.at).slice(0, 3);
  let newest = settings.lastAlertAt;
  for (const a of alerts) {
    const result = await host.call("notifications.show", { title: clip(a.title, 120), body: clip(a.body, 1000) });
    if (!result.delivered)
      break;
    state.delivered.add(id(a));
    newest = Math.max(newest, a.at);
  }
  if (newest > settings.lastAlertAt) {
    settings.lastAlertAt = newest;
    await host.call("settings.set", { key: "lastAlertAt", value: newest });
  }
  return newest;
}

// orca-plugin/src/panel.ts
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function jsonForScript(v) {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function renderPanel(s, view) {
  const h = (v) => escapeHtml(String(v ?? ""));
  const console = liveConsole(s, view.nowS);
  const actions = {};
  if (console)
    for (const [id, data] of [["delegate", { cmd: "delegate" }], ["strategy", { cmd: "use" }], ["refresh", { cmd: "refresh" }]]) {
      actions[id] = { terminalId: console.handle, text: encodeCmdLine(data), enter: true };
    }
  const providers = (s.budget?.providers ?? []).map((p) => `<tr><td>${h(p.id)}</td><td>${h(p.verdict)}</td><td>${h(p.usedPct === null ? "?" : `${Math.round(p.usedPct)}%`)}</td><td>${h(p.window ?? "?")}</td><td>${h(p.resetsAt === null ? "?" : `resets in ${Math.max(0, (p.resetsAt - view.nowS) / 3600).toFixed(1)}h`)}</td><td>${h(p.stale ? "stale" : "")}</td></tr>`).join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>pacer budget</title><style>
body{background:var(--background);color:var(--foreground);font:14px system-ui,sans-serif;margin:20px;line-height:1.5}h1{font-size:20px}h2{font-size:16px;margin-top:24px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px;border-bottom:1px solid var(--border)}footer,#status{color:var(--muted-foreground);margin-top:16px}button{background:var(--background);color:var(--foreground);border:1px solid var(--border);border-radius:var(--radius);padding:8px 12px;margin-right:8px;cursor:pointer}button:disabled{color:var(--muted-foreground);cursor:default}li{overflow-wrap:anywhere}p{white-space:pre-wrap}
</style></head><body>
<h1>pacer budget</h1><p>${h(summaryLine(s.budget))}</p>
<h2>Providers</h2><table><thead><tr><th>Provider</th><th>Verdict</th><th>Used</th><th>Window</th><th>Reset</th><th>Freshness</th></tr></thead><tbody>${providers}</tbody></table>
<h2>Ranked executors</h2><ol>${(s.budget?.ranked ?? []).slice(0, 5).map((r) => `<li>${h(r.id)} ${h(r.verdict)}</li>`).join("")}</ol>
<h2>Tasks</h2><ul>${s.tasks.slice(0, 10).map((t) => `<li>${h(t.state)}: ${h(t.goal)} (${h(t.executor ?? "none")})</li>`).join("")}</ul>
<h2>Alerts</h2>${s.alerts.slice(0, 5).map((a) => `<article><strong>${h(a.level)}: ${h(a.title)}</strong><p>${h(a.body)}</p></article>`).join("")}
<div>${[["delegate", "Delegate"], ["strategy", "Switch strategy"], ["refresh", "Refresh"]].map(([id, label]) => `<button data-action="${h(id)}"${console ? "" : " disabled"}>${h(label)}</button>`).join("")}</div>
<p id="status" role="status"></p>
<footer>as of ${h(s.at === 0 ? "unknown" : new Date(s.at * 1000).toLocaleTimeString())} via ${h(view.transport ?? "none")}. Reopen this panel to refresh.${console ? "" : "<p>Start the console: pacer console --open</p>"}${view.reachable ? "" : "<p>pacer link is unreachable</p>"}</footer>
<script type="application/json" id="pacer-actions">${jsonForScript(actions)}</script>
<script>
const actions = JSON.parse(document.getElementById("pacer-actions").textContent);
const status = document.getElementById("status");
const pending = new Set();
const sentAt = [];
let sequence = 0;
for (const button of document.querySelectorAll("button[data-action]")) button.addEventListener("click", () => {
  const params = actions[button.dataset.action];
  if (!params) return;
  if (Date.now() > ${jsonForScript((console?.heartbeatAt ?? 0) * 1000 + 30000)}) {
    for (const b of document.querySelectorAll("button[data-action]")) b.disabled = true;
    status.textContent = "Console heartbeat expired. Reopen this panel to refresh.";
    return;
  }
  const now = Date.now();
  while (sentAt.length && now - sentAt[0] >= 10000) sentAt.shift();
  if (sentAt.length >= 30) { status.textContent = "Please wait before sending another console command."; return; }
  sentAt.push(now);
  const requestId = "pacer-" + (++sequence);
  pending.add(requestId);
  window.parent.postMessage({type:"orca-panel-action",requestId,action:"terminal.sendText",params}, "*");
});
window.addEventListener("message", event => {
  const r = event.data;
  if (event.source !== window.parent || !r || r.type !== "orca-panel-action-result" || !pending.delete(r.requestId)) return;
  status.textContent = r.ok && r.value && r.value.accepted ? "Sent to pacer console" : (r.error || "Orca refused to type into the pacer console");
});
</script></body></html>`;
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
    let cancelSettings = () => {};
    try {
      const result = await Promise.race([
        ctx.host.call("settings.get"),
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
    let processing = Promise.resolve();
    let httpFailures = 0;
    let renderedConsoleLive = false;
    const logError = (e) => ctx.log(`pacer: ${e instanceof Error ? e.message : String(e)}`);
    const scheduleRender = () => {
      if (stopped || cancelRender)
        return;
      cancelRender = timers.after(2000, () => {
        cancelRender = null;
        if (stopped)
          return;
        try {
          if (deps.fs.exists(join(deps.pluginRoot, ".pacer-managed")))
            deps.fs.writeTextAtomic(join(deps.pluginRoot, "panel", "live.html"), renderPanel(store.snapshot, { nowS: deps.nowS(), transport: store.transport, reachable }));
          else
            ctx.log("pacer: refused panel write: unmanaged root");
        } catch (e) {
          logError(e);
        }
        renderedConsoleLive = !!liveConsole(store.snapshot, deps.nowS());
        const snapshot = store.snapshot;
        processing = processing.then(async () => {
          if (!stopped)
            await notifyNewAlerts(ctx.host, snapshot, settings, activatedAtS);
        }).catch(logError);
      });
    };
    store.onChange(scheduleRender);
    const replaceSnapshot = (snapshot) => {
      if (stopped)
        return;
      store.replace(snapshot);
      if (!!liveConsole(snapshot, deps.nowS()) !== renderedConsoleLive)
        scheduleRender();
    };
    const acceptSnapshot = (snapshot) => {
      if (stopped)
        return;
      httpFailures = 0;
      if (!reachable) {
        reachable = true;
        scheduleRender();
      }
      replaceSnapshot(snapshot);
    };
    const connect = async () => {
      const chosen = await chooseTransport(transports, settings.transport);
      if (stopped)
        return;
      active = chosen.transport;
      reachable = chosen.reachable;
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
        if (!stopped)
          store.apply(e);
      }, acceptSnapshot, () => {
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
        await ctx.host.call("notifications.show", { title: clip(title, 120), ...body === undefined ? {} : { body: clip(body, 1000) } });
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
        if (snapshot)
          acceptSnapshot(snapshot);
        else if (active?.id === "http")
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
      return send({ cmd: "delegate", ...context ? { branch: context.branch, displayName: context.displayName } : {} });
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
      const c = liveConsole(store.snapshot, deps.nowS());
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
      await sendToConsole(ctx.host, store.snapshot, { cmd: "agent-done", paneKey: p.paneKey, ...typeof p.worktreeId === "string" ? { worktreeId: p.worktreeId } : {} }, now);
    });
    ctx.events.on("worktree.created", async (payload) => {
      await ensureConnected();
      if (!payload || typeof payload !== "object")
        return;
      const p = payload;
      if (typeof p.branch !== "string" || !/(^|\/)pacer-/.test(p.branch) || typeof p.worktreeId !== "string" || typeof p.path !== "string")
        return;
      await sendFresh({ cmd: "worktree-created", worktreeId: p.worktreeId, path: p.path, branch: p.branch });
    });
    try {
      ctx.host.call("events.subscribe", { events: ["agent.status.changed", "worktree.created"] }).catch(logError);
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
