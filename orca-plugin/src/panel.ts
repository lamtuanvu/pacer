import { encodeCmdLine, liveConsole, summaryLine, type CmdData, type LinkSnapshot } from "../../src/link/envelope";
import type { TransportId } from "./transports/choose";
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
export function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
export function renderPanel(s: LinkSnapshot, view: { nowS: number; transport: TransportId | null; reachable: boolean }): string {
  const h = (v: unknown) => escapeHtml(String(v ?? ""));
  const console = liveConsole(s, view.nowS);
  const actions: Record<string, { terminalId: string; text: string; enter: true }> = {};
  if (console) for (const [id, data] of [["delegate", { cmd: "delegate" }], ["strategy", { cmd: "use" }], ["refresh", { cmd: "refresh" }]] as [string, CmdData][]) {
    actions[id] = { terminalId: console.handle!, text: encodeCmdLine(data), enter: true };
  }
  const providers = (s.budget?.providers ?? []).map(p => `<tr><td>${h(p.id)}</td><td>${h(p.verdict)}</td><td>${h(p.usedPct === null ? "?" : `${Math.round(p.usedPct)}%`)}</td><td>${h(p.window ?? "?")}</td><td>${h(p.resetsAt === null ? "?" : `resets in ${Math.max(0, (p.resetsAt - view.nowS) / 3600).toFixed(1)}h`)}</td><td>${h(p.stale ? "stale" : "")}</td></tr>`).join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>pacer budget</title><style>
body{background:var(--background);color:var(--foreground);font:14px system-ui,sans-serif;margin:20px;line-height:1.5}h1{font-size:20px}h2{font-size:16px;margin-top:24px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px;border-bottom:1px solid var(--border)}footer,#status{color:var(--muted-foreground);margin-top:16px}button{background:var(--background);color:var(--foreground);border:1px solid var(--border);border-radius:var(--radius);padding:8px 12px;margin-right:8px;cursor:pointer}button:disabled{color:var(--muted-foreground);cursor:default}li{overflow-wrap:anywhere}p{white-space:pre-wrap}
</style></head><body>
<h1>pacer budget</h1><p>${h(summaryLine(s.budget))}</p>
<h2>Providers</h2><table><thead><tr><th>Provider</th><th>Verdict</th><th>Used</th><th>Window</th><th>Reset</th><th>Freshness</th></tr></thead><tbody>${providers}</tbody></table>
<h2>Ranked executors</h2><ol>${(s.budget?.ranked ?? []).slice(0, 5).map(r => `<li>${h(r.id)} ${h(r.verdict)}</li>`).join("")}</ol>
<h2>Tasks</h2><ul>${s.tasks.slice(0, 10).map(t => `<li>${h(t.state)}: ${h(t.goal)} (${h(t.executor ?? "none")})</li>`).join("")}</ul>
<h2>Alerts</h2>${s.alerts.slice(0, 5).map(a => `<article><strong>${h(a.level)}: ${h(a.title)}</strong><p>${h(a.body)}</p></article>`).join("")}
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
