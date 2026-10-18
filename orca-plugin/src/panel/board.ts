/// <reference path="./tokens.d.ts" />
import tokens from "../../../app/src/ds/tokens.css" with { type: "text" };
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import type { Scope } from "../../../src/view-model/selectors";
import type { RepoRef } from "../../../src/api/read-model/types";
import { capacity, counts, doneToday, needsYou, otherReposNeedingYou, running } from "../../../src/view-model/selectors";
import { clock } from "../../../src/view-model/format";
import { executorLabel, phaseWords, taskStatus, toneFor } from "../../../src/view-model/words";
import { h } from "./shared";
import { agentStyle, icon } from "./icons";

const command = (line: string) => `<code>${h(line)}</code>`;
const quote = (value: unknown) => `'${String(value).replace(/'/g, "'\\''")}'`;
function sections(s: ClientSnapshot, scope: Scope): string {
 const needs = needsYou(s, scope), runs = running(s, scope), done = doneToday(s, scope), executors = capacity(s);
 const hidden = otherReposNeedingYou(s, scope), next = executors.find(e => e.next);
 const section = (name: string, count: number, body: string, extra = "") => `<section class="stack section" aria-label="${name}"><div class="row"><h2>${name}</h2><span class="pill">${count}</span><span class="grow"></span>${extra}</div>${body}</section>`;
 const repo = (r?: RepoRef | null) => scope.repo === null && r ? ` · ${h(r.label)}` : "";
 return section("Needs you", needs.length, needs.map(n => {
  const actions = n.actions.map((a, index) => {
   const p = a.params, id = p.id ?? n.taskId;
   const line = a.op === "ui.open" ? `pacer open ${quote(`${p.view === "task" ? "sessions" : p.view === "session" ? "sessions" : p.view ?? "overview"}${p.view === "settings" && p.section ? `/${p.section}` : id ? `/${id}` : ""}`)}`
    : a.op === "host.check" ? `pacer host check ${quote(p.alias ?? n.host)}`
    : a.op === "task.retry" ? `pacer retry ${quote(id)}${p.executor ? ` --executor ${quote(p.executor)}` : ""}`
    : a.op === "task.review" ? `pacer review ${quote(id)} --${p.verdict === "accept" ? "accept" : "reject"}`
    : `pacer open ${quote(n.taskId ? `review/${n.taskId}` : n.host ? "settings/hosts" : "overview")}`;
   return {label:`<span class="action-block ${index === 0 ? "action-primary" : "action-secondary"}">${h(a.label)}</span>`, line:command(line)};
  });
  const executor=n.executor ?? s.tasks.find(t=>t.id===n.taskId)?.executor;
  return `<article class="card stack ${n.severity === "blocked" ? "bad" : n.severity === "problem" ? "warn" : "info"}"><div class="row attention-heading">${executor ? icon(executor,22,n.account) : ""}<div class="stack grow"><strong>${h(n.title)}</strong><small>${n.kind === "failed" ? '<span class="bad" aria-label="Failed">✗</span> ' : ""}${h(n.detail)}${repo(n.repo)}</small></div></div><div class="row actions">${actions.map(a=>a.label).join("")}</div><div class="stack action-commands">${actions.map(a=>a.line).join("")}</div></article>`;
 }).join("") || '<small>Nothing needs you here.</small>', hidden ? `<a href="#all-repos">+${hidden} in other repos</a>` : "")
 + section("Running", runs.length, runs.map(t => `<article class="card stack"><div class="row">${t.executor ? icon(t.executor,22) : ""}<strong class="grow">${h(t.goal.slice(0, 100))}</strong></div><small>${h(executorLabel(t.executor))} · ${h(t.progress ? phaseWords(t.progress.phase) : taskStatus(t).label)} · ${h(clock(t.attemptStartedAt ?? t.updatedAt, s.at))}${repo(t.repo)}</small>${command(`pacer open ${quote(`sessions/${t.id}`)}`)}</article>`).join("") || '<small>Nothing running here.</small>')
 + section("Capacity", executors.length, `<div class="card row capacity">${executors.map(e => `<span class="executor ${toneFor(e.tone)}" title="${h(`${executorLabel(e.id)} · ${e.sub}`)}">${icon(e.agent, 24, e.account)}<span class="dot" aria-hidden="true"></span><span class="sr-only">${h(`${executorLabel(e.id)} · ${e.sub}`)}</span></span>`).join("")}<span class="grow"></span><small>${counts(s)?.ready ?? 0} ready${executors.some(e=>e.state === "down") ? ` · ${executors.filter(e=>e.state === "down").length} down` : ""}</small></div>`, next ? `<small>next: ${h(executorLabel(next.id))}</small>` : "")
 + section("Done today", done.length, done.map(t => { const status = taskStatus(t); return `<div class="row done ${status.tone}"><span title="${h(status.label)}" aria-label="${h(status.label)}">${status.tone === "good" ? "✓" : status.tone === "bad" ? "✗" : "·"}</span><span class="grow">${h(t.goal)}${repo(t.repo)}</span>${t.executor ? icon(t.executor,16) : ""}<small class="done-time">${h(clock(t.updatedAt, s.at))}</small></div>`; }).join("") || '<small>Nothing done here today.</small>');
}
export function board(s: ClientSnapshot, repo: RepoRef | null): string {
 const nav = (all: boolean) => `<nav class="scope-toggle" aria-label="Scope"><a href="#this-repo"${!all ? ' aria-current="true"' : ""}>This repo${repo ? ` · ${h(repo.label)}` : ""}</a><a href="#all-repos"${all ? ' aria-current="true"' : ""}>All repos</a></nav>`;
 return `<div id="all-repos" class="scope-all stack">${nav(true)}${sections(s, {repo:null})}</div><div id="this-repo" class="scope-here stack">${nav(false)}${sections(s, {repo:repo?.key ?? "__unknown_repo__"})}</div>`;
}
export const boardStyle = `${tokens}
${agentStyle}
body{background:var(--surface-page);color:var(--ink);font:13px/19px var(--font-sans)}
.content{gap:14px;padding:10px 16px}.stack{gap:6px}.scope-here,.scope-all{gap:14px}.scope-all{display:none}.scope-all:target{display:flex}.scope-all:target~.scope-here{display:none}
a{color:var(--link)}a:hover{color:var(--ink)}a:focus-visible{outline:2px solid var(--focus);outline-offset:3px}a[aria-current]{font-weight:650}
.scope-toggle{display:flex;align-items:stretch;gap:6px}.scope-toggle a{display:flex;align-items:center;justify-content:center;flex:1 1 0;min-width:0;min-height:32px;padding:5px 8px;border:1px solid var(--line);border-radius:999px;background:var(--surface-page);color:var(--ink);font-size:12px;text-align:center;text-decoration:none}.scope-toggle a[aria-current]{background:var(--ink);border-color:var(--ink);color:var(--ink-on-ink)}
.attention-heading{align-items:flex-start}.attention-heading .stack{gap:2px}.actions{align-items:stretch;gap:6px}.action-block{display:flex;align-items:center;justify-content:center;min-height:30px;padding:5px 10px;border:1px solid var(--line);border-radius:6px;color:var(--ink);background:var(--surface-page);font-size:12px;text-align:center}.action-primary{flex:1;background:var(--ink);color:var(--ink-on-ink);border-color:var(--ink);font-weight:600}.action-commands code{display:block}.footer-actions{display:flex;flex-direction:column;gap:8px}.footer-actions .action-block{flex-direction:column;align-items:stretch;gap:4px;padding:10px;text-align:left}.footer-actions code{color:inherit}.planner-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px}.planner-summary strong{font-weight:600}.planner-stats{text-align:right}.done-time{flex:none;text-align:right}.done .agent-mark{margin-left:auto}
header{padding-bottom:10px;border-bottom:1px solid var(--line)}.brand-tick{fill:var(--track)}.pill{background:var(--surface-lane);border-radius:999px}h2{color:var(--ink);font-size:11px;font-weight:600}.live,small,footer{color:var(--ink-muted);font-size:12px}
.card{border-color:var(--line);border-radius:10px;background:var(--surface-page);padding:8px 10px}.card.warn{border-color:var(--warn-line);background:var(--warn-tint)}.card.bad{border-color:var(--bad-line);background:var(--bad-tint)}.card strong{color:var(--ink)}
.good{color:var(--good-fg)}.warn{color:var(--warn-fg)}.bad{color:var(--bad-fg)}.info{color:var(--info-fg)}.neutral{color:var(--ink-muted)}.meter{background:var(--surface-lane)}.pace{background:var(--ink)}
code{font-family:var(--font-mono)}pre{background:var(--surface-lane)}footer{border-color:var(--line)}.capacity{flex-wrap:wrap;gap:12px}.executor{position:relative;display:inline-flex}.dot{position:absolute;right:-3px;bottom:-3px;width:8px;height:8px;border-radius:50%;background:currentColor;border:1px solid var(--surface-page)}.monogram{display:inline-flex;align-items:center;justify-content:center;font-size:11px}.done{font-size:12px}.done .grow{color:var(--ink)}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
`;

