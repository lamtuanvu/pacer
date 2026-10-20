/** Settings: sections on the left, the selected section on the right. Every read and write is an API op (ARCH-1). */
import type { ExecutorRow, HostSummary } from "../../api/read-model/types";
import { capacityNote } from "../../view-model/capacity";
import { executorLabel, executorStatus, type Status } from "../../view-model/words";
import { cols, flex, glyph, heading, span, statusSpans, wrap, type Line } from "../frame";
import type { Act, Item } from "../state";
import { blank, defined, empty, executorName, GAP, MARK, opAct, time, updateState } from "./common";
import { errorRows } from "./review";
import type { Resource, Row, ScreenCtx, ScreenView, SettingsData } from "./types";

export const SECTIONS: { id: string; label: string; needs: (keyof SettingsData)[] }[] = [
  { id: "planner", label: "Planner & pacing", needs: ["config"] },
  { id: "accounts", label: "Accounts", needs: ["accounts"] },
  { id: "executors", label: "Executors", needs: [] },
  { id: "machine", label: "This machine", needs: ["config"] },
  { id: "hosts", label: "Remote hosts", needs: [] },
  { id: "routing", label: "Routing", needs: ["routing"] },
  { id: "projects", label: "Project strategies", needs: ["projects"] },
  { id: "strategies", label: "Strategies", needs: ["strategies"] },
  { id: "updates", label: "Updates", needs: ["update", "config"] },
  { id: "notifications", label: "Notifications", needs: ["notifications"] },
  { id: "appearance", label: "Appearance", needs: [] },
];
export const POLICIES: [string, string][] = [["priority", "Priority"], ["even", "Even"], ["burn-before-reset", "Burn before reset"], ["cheapest-first", "Cheapest first"]];
const LEVELS: [string, string][] = [["off", "Off"], ["important", "Important"], ["all", "All"]];

interface Section { rows: Row[]; items: Item[]; hints?: string[] }
/** A row's second line is prose (reasons, usage, executors): wrap it, never clip it (UI-11, UI-13). */
const prose = (item: string, text: string, width: number): Row[] =>
  wrap(text, Math.max(10, width - MARK)).map(line => ({ item, cont: true, line: [span(line, { fg: "muted" })] }));
type Build = (ctx: ScreenCtx, width: number) => Section;

const set = (ctx: ScreenCtx, label: string, key: string, value: unknown, extra: Partial<Act> = {}) => opAct(ctx, label, "config.set", { key, value }, extra);
const cycle = <T,>(values: T[], current: T, step: number) => values[(values.indexOf(current) + step + values.length) % values.length]!;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
/** A label/value row in a fixed label column (TextRow). */
function field(ctx: ScreenCtx, width: number, label: string, value: Line, note?: string): Line {
  const w = flex(width, [{ fixed: 24 }, { weight: 1, min: 10 }]);
  return cols([{ content: label, width: w[0]!, style: { fg: "secondary" } }, { content: [...value, ...(note ? [span(`  ${note}`, { fg: "muted" })] : [])], width: w[1]! }], GAP, ctx.theme);
}
function resourceState<T>(ctx: ScreenCtx, resource: Resource<T> | undefined, text = "Loading…"): Row[] | undefined {
  if (resource?.value !== undefined) return undefined;
  if (resource?.error) return errorRows(ctx, resource.error);
  return [{ line: [span(ctx.spinner ? `${ctx.spinner} ${text}` : text, { fg: "muted" })] }];
}
const unsupported = (op: string): Row => empty(`Not offered by this pacer service (${op}).`);

const planner: Build = (ctx, width) => {
  const rows: Row[] = [], items: Item[] = [], config = ctx.data.settings.config;
  if (!ctx.supports("config.get")) return { rows: [unsupported("config.get")], items };
  const pending = resourceState(ctx, config);
  if (pending) return { rows: pending, items };
  const keys = config!.value!.keys ?? {}, value = (k: string) => keys[k]?.value;
  const plannerId = String(value("planner") ?? ""), planners = config!.value!.planners ?? [];
  const choose: Act | undefined = ctx.supports("config.set") && planners.length > 1 ? {
    label: "Change planner",
    effect: { type: "choose", title: "Planner", options: planners.map(id => ({ label: `${executorLabel(id)}${id === plannerId ? " · current" : ""}`, effect: { type: "flow", name: "change-planner", params: { value: id } } })) },
  } : undefined;
  items.push({ id: "setting:planner", primary: choose, actions: [], keys: {} });
  rows.push({ item: "setting:planner", line: field(ctx, width, "Planner", [span(executorLabel(plannerId), { bold: true }), span(`  ${plannerId}`, { fg: "muted" })]) });
  if (ctx.s.planner?.advice) rows.push({ line: field(ctx, width, "", [span(ctx.s.planner.advice, { fg: "secondary" })]) });

  const policy = String(value("pacing.policy") ?? "priority"), policyIds = POLICIES.map(p => p[0]);
  const policyAct = (step: number) => set(ctx, "Policy", "pacing.policy", cycle(policyIds, policy, step));
  const prevPolicy = policyAct(-1), nextPolicy = policyAct(1);
  items.push({ id: "setting:policy", primary: nextPolicy, actions: [], keys: { ...(prevPolicy ? { left: prevPolicy } : {}), ...(nextPolicy ? { right: nextPolicy } : {}) } });
  rows.push({ item: "setting:policy", line: field(ctx, width, "Policy", POLICIES.flatMap(([id, label], i): Line => [...(i ? [span("  ")] : []), span(id === policy ? `[${label}]` : label, id === policy ? { fg: "focus", bold: true } : { fg: "muted" })])) });

  const number = (id: string, label: string, key: string, min: number, max: number, fallback: number, unit = "%", note?: string) => {
    const current = Number(value(key) ?? fallback);
    const step = (n: number) => clamp(current + n, min, max) === current ? undefined : set(ctx, label, key, clamp(current + n, min, max));
    const keysFor: Record<string, Act> = {};
    const down = step(-5), up = step(5);
    if (down) keysFor.left = down;
    if (up) keysFor.right = up;
    items.push({ id: `setting:${id}`, actions: [], keys: keysFor });
    rows.push({ item: `setting:${id}`, line: field(ctx, width, label, [span(`${glyph(ctx.theme, "‹")} `, { fg: "muted" }), span(`${current}${unit}`, { bold: true }), span(` ${glyph(ctx.theme, "›")}`, { fg: "muted" })], note ?? `${min}–${max}, steps of 5`) });
  };
  number("reserve", "Planner reserve", "pacing.planner_reserve", 0, 50, 10, "%", "kept for planning and review");
  const accountsMode = String(value("pacing.accounts") ?? "spread");
  const modeAct = set(ctx, "Multiple accounts", "pacing.accounts", accountsMode === "spread" ? "fill" : "spread");
  items.push({ id: "setting:accounts-mode", primary: modeAct, actions: [], keys: modeAct ? { left: modeAct, right: modeAct } : {} });
  rows.push({ item: "setting:accounts-mode", line: field(ctx, width, "Multiple accounts", [["spread", "Spread"], ["fill", "Fill"]].flatMap(([id, label], i): Line => [...(i ? [span("  ")] : []), span(id === accountsMode ? `[${label}]` : label!, id === accountsMode ? { fg: "focus", bold: true } : { fg: "muted" })])) });
  if (accountsMode === "fill") number("threshold", "Move to the next account at", "pacing.fill_threshold", 50, 100, 80, "% used");
  return { rows, items, hints: ["← → adjust"] };
};

const SIGNIN: Record<string, Status> = {
  true: { label: "Signed in", tone: "good", glyph: "✓" },
  false: { label: "Sign-in needed", tone: "warn", glyph: "!" },
  null: { label: "Unknown", tone: "neutral", glyph: "?" },
};
const accounts: Build = (ctx, width) => {
  const rows: Row[] = [], items: Item[] = [], resource = ctx.data.settings.accounts;
  if (!ctx.supports("account.list")) return { rows: [unsupported("account.list")], items };
  const add: Act = { label: "Add account", effect: { type: "handoff", argv: ["account", "add"], label: "Add account" } };
  const link: Act = { label: "Link Orca account", effect: { type: "handoff", argv: ["account", "add", "--orca"], label: "Link Orca account" } };
  const shared = { a: add, l: link };
  rows.push({ line: [span("Where quota comes from. An executor uses one account.", { fg: "secondary" })] }, blank());
  const pending = resourceState(ctx, resource);
  if (pending) return { rows: [...rows, ...pending], items };
  const list = Array.isArray(resource!.value) ? resource!.value : [];
  if (!list.length) rows.push(empty("No accounts yet. Add an account to get started."));
  const w = flex(width, [{ weight: 1, min: 12 }, { fixed: 22 }, { fixed: 18 }]);
  for (const a of list) {
    const usage = ctx.s.accounts?.find(x => x.name === a.name);
    const signed = usage?.signedIn ?? a.signedIn ?? null;
    const fix = signed !== true ? opAct(ctx, "Fix sign-in", "account.signin", { name: a.name }) : undefined;
    const remove = !a.locked ? opAct(ctx, "Remove", "account.remove", { name: a.name }, { danger: true, confirm: { title: `Remove account ${a.name}?`, body: ["Its folder stays on disk."], yes: "Remove" } }) : undefined;
    const id = `account:${a.name}`;
    items.push({ id, primary: fix, actions: defined([remove]), keys: { ...shared, ...(remove ? { x: remove } : {}) } });
    rows.push({ item: id, line: cols([
      { content: a.label && a.label !== a.name ? `${a.name} (${a.label})` : a.name, width: w[0]!, style: { bold: true } },
      { content: [a.kind, a.source].filter(Boolean).join(" · "), width: w[1]!, style: { fg: "secondary" } },
      { content: statusSpans(ctx.theme, SIGNIN[String(signed)]!), width: w[2]! },
    ], GAP, ctx.theme) });
    const used = usage?.usedPct != null ? `${Math.round(usage.usedPct)}% of ${usage.window === "weekly" ? "week" : usage.window ?? "quota"}${usage.resetsAt ? ` · resets ${time(ctx, usage.resetsAt)}` : ""}` : "Usage unknown";
    const users = a.executors ?? a.runners ?? [];
    rows.push(...prose(id, `${used} ${glyph(ctx.theme, "·")} ${users.length ? `Used by ${users.map(u => executorLabel(u)).join(", ")}` : "Not used"}${a.locked ? ` ${glyph(ctx.theme, "·")} ${a.locked}` : ""}`, width));
  }
  rows.push(blank());
  for (const [id, act] of [["account-add", add], ["account-link", link]] as const) {
    items.push({ id, primary: act, actions: [], keys: shared });
    rows.push({ item: id, line: [span(`+ ${act.label}`, { fg: "secondary" })] });
  }
  return { rows, items };
};

const executors: Build = (ctx, width) => {
  const rows: Row[] = [], items: Item[] = [], list = ctx.s.executors ?? [];
  const add: Act = { label: "Add executor", effect: { type: "handoff", argv: ["runner", "add"], label: "Add executor" } };
  rows.push({ line: [span("Agent + account + where it runs. Set the priority order.", { fg: "secondary" })] }, blank());
  if (!list.length) rows.push(empty("No executors yet. Add one."));
  const ordered = list.filter(e => e.rank !== "planner").sort((a, b) => Number(a.rank) - Number(b.rank)).map(e => e.id);
  const w = flex(width, [{ fixed: 2 }, { fixed: 30 }, { fixed: 15 }, { weight: 1, min: 3 }]);
  for (const e of list) {
    const id = `executor:${e.id}`, planner = e.rank === "planner", i = ordered.indexOf(e.id);
    const move = (step: number): Act | undefined => {
      const j = i + step;
      if (planner || j < 0 || j >= ordered.length) return undefined;
      const ids = [...ordered];
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      return opAct(ctx, step < 0 ? "Move up" : "Move down", "runner.reorder", { ids });
    };
    const check = opAct(ctx, "Run check", "runner.check", { id: e.id });
    const toggle = planner ? undefined : opAct(ctx, e.enabled ? "Disable" : "Enable", "runner.set", { id: e.id, enabled: !e.enabled });
    const block = planner ? undefined : opAct(ctx, e.state === "blocked" ? "Unblock" : "Block", e.state === "blocked" ? "runner.unblock" : "runner.block", { id: e.id });
    const remove = planner ? undefined : opAct(ctx, "Remove", "runner.remove", { id: e.id }, { danger: true, confirm: { title: `Remove executor ${e.id}?`, body: ["Routing rules and the priority order drop it too."], yes: "Remove" } });
    const up = move(-1), down = move(1);
    items.push({ id, primary: check, actions: defined([toggle, block, up, down, remove]), keys: { a: add, ...(toggle ? { e: toggle } : {}), ...(block ? { b: block } : {}), ...(up ? { "[": up } : {}), ...(down ? { "]": down } : {}), ...(remove ? { x: remove } : {}) } });
    rows.push({ item: id, line: cols([
      { content: planner ? "P" : String(e.rank), width: w[0]!, style: { fg: "muted" } },
      { content: executorName(ctx.theme, e.id), width: w[1]!, style: { bold: true } },
      { content: statusSpans(ctx.theme, executorStatus(e.state)), width: w[2]! },
      { content: e.enabled ? "" : "off", width: w[3]!, style: { fg: "muted" } },
    ], GAP, ctx.theme) });
    rows.push(...prose(id, executorFacts(ctx, e), width));
  }
  rows.push(blank());
  items.push({ id: "executor-add", primary: add, actions: [], keys: { a: add } });
  rows.push({ item: "executor-add", line: [span(`+ ${add.label}`, { fg: "secondary" })] });
  rows.push(blank(), ...wrap("The planner can't be removed. An executor that fails its check is skipped until it passes again.", width).map(text => ({ line: [span(text, { fg: "muted" })] })));
  return { rows, items };
};
function executorFacts(ctx: ScreenCtx, e: ExecutorRow): string {
  const check = e.lastCheck ? `${e.lastCheck.passed ? "check passed" : "check failed"} ${time(ctx, e.lastCheck.at)}` : "not checked";
  const note = capacityNote(e, ctx.s);
  return [e.id, e.model ?? "agent default", e.host ? `runs on ${e.host}` : "this machine", `${e.slots.used}/${e.slots.max} tasks`, check, e.reason, note].filter(Boolean).join(` ${glyph(ctx.theme, "·")} `);
}

const machine: Build = (ctx, width) => {
  const rows: Row[] = [], items: Item[] = [], config = ctx.data.settings.config;
  const pending = resourceState(ctx, config);
  if (pending) return { rows: pending, items };
  const current = Number(config!.value!.keys?.["execution.local_max_tasks"]?.value ?? 2);
  const step = (n: number) => clamp(current + n, 1, 16) === current ? undefined : set(ctx, "Parallel tasks", "execution.local_max_tasks", clamp(current + n, 1, 16));
  const down = step(-1), up = step(1);
  items.push({ id: "setting:local-max", actions: [], keys: { ...(down ? { left: down } : {}), ...(up ? { right: up } : {}) } });
  const busy = ctx.s.machine ? `${ctx.s.machine.used} busy now` : undefined;
  rows.push({ item: "setting:local-max", line: field(ctx, width, "Parallel tasks", [span(`${glyph(ctx.theme, "‹")} `, { fg: "muted" }), span(String(current), { bold: true }), span(` ${glyph(ctx.theme, "›")}`, { fg: "muted" })], busy) });
  rows.push({ line: field(ctx, width, "", [span("Shared by all executors that run on this machine. 1–16.", { fg: "muted" })]) });
  return { rows, items, hints: ["← → adjust"] };
};

const HOST: Record<HostSummary["state"], Status> = {
  ready: { label: "Ready", tone: "good", glyph: "✓" }, down: { label: "Not answering", tone: "bad", glyph: "✕" },
  checking: { label: "Checking", tone: "info", glyph: "…" }, paused: { label: "Paused", tone: "neutral", glyph: "■" },
  needs_setup: { label: "Needs setup", tone: "warn", glyph: "!" }, unknown: { label: "Not checked", tone: "neutral", glyph: "?" },
};
const hosts: Build = (ctx, width) => {
  const rows: Row[] = [], items: Item[] = [], list = ctx.s.hosts ?? [];
  rows.push({ line: [span("Machines that run Codex or Claude Code over SSH.", { fg: "secondary" })] }, blank());
  if (!list.length) rows.push(empty("No remote hosts yet. Add one with pacer host add."));
  const w = flex(width, [{ weight: 1, min: 10 }, { fixed: 16 }, { fixed: 12 }]);
  for (const h of list) {
    const id = `host:${h.alias}`;
    const check = opAct(ctx, "Run checks", "host.check", { alias: h.alias });
    const pause = opAct(ctx, h.state === "paused" ? "Resume new work" : "Pause new work", "host.set", { alias: h.alias, paused: h.state !== "paused" });
    items.push({ id, primary: check, actions: defined([pause]), keys: pause ? { p: pause } : {} });
    rows.push({ item: id, line: cols([
      { content: [span(h.alias, { bold: true }), span(`  ssh ${h.ssh}`, { fg: "muted" })], width: w[0]! },
      { content: statusSpans(ctx.theme, HOST[h.state] ?? HOST.unknown), width: w[1]! },
      { content: `${h.running} / ${h.maxTasks} busy`, width: w[2]!, align: "right", style: { fg: "secondary" } },
    ], GAP, ctx.theme) });
    rows.push(...prose(id, `${h.executors.length ? h.executors.map(x => executorLabel(x)).join(", ") : "No executors"} ${glyph(ctx.theme, "·")} ${h.repos} ${h.repos === 1 ? "repo" : "repos"}`, width));
  }
  rows.push(blank(), ...wrap("Add hosts, map repositories and clean up worktrees with pacer host, or in the app: pacer open settings.", width).map(text => ({ line: [span(text, { fg: "muted" })] })));
  return { rows, items };
};

const KIND_HELP = "Kinds: boilerplate, tests, docs, rename, migration, feature, debug, refactor, performance, unfamiliar-code, research";
const splitList = (value: string) => value.split(",").map(x => x.trim()).filter(Boolean);
const routing: Build = (ctx, width) => {
  const rows: Row[] = [], items: Item[] = [], resource = ctx.data.settings.routing;
  if (!ctx.supports("routing.get")) return { rows: [unsupported("routing.get")], items };
  rows.push({ line: [span("Which executors a kind of task may use, in order. First match wins.", { fg: "secondary" })] }, blank());
  const pending = resourceState(ctx, resource);
  if (pending) return { rows: [...rows, ...pending], items };
  const rules = resource!.value!.rules ?? [], available = resource!.value!.available ?? [];
  const save = (next: typeof rules, label: string) => ({ type: "action" as const, action: { label, op: "routing.set", params: { rules: next } } });
  const canSet = ctx.supports("routing.set"), help = `Available: ${available.join(", ")}`;
  const addRule: Act | undefined = canSet ? {
    label: "Add rule",
    effect: { type: "prompt", prompt: { title: "Add a routing rule", label: "Task kinds (comma separated)", help: KIND_HELP, required: "Name at least one kind.", submit: kinds => ({ type: "prompt", prompt: { title: "Add a routing rule", label: `Executors for ${kinds}, in order`, help, required: "Name at least one executor.", submit: ids => save([...rules.slice(0, -1), { kinds: splitList(kinds), executors: splitList(ids) }, ...rules.slice(-1)], "Rule added") } }) } },
  } : undefined;
  if (!rules.length) rows.push(empty("No routing rules yet."));
  const w = flex(width, [{ fixed: 26 }, { weight: 1, min: 10 }]);
  rules.forEach((rule, i) => {
    const id = `rule:${i}`, last = i === rules.length - 1 && !rule.kinds;
    const edit: Act | undefined = canSet ? { label: "Edit executor order", effect: { type: "prompt", prompt: { title: rule.kinds ? `Rule ${i + 1} · ${rule.kinds.join(", ")}` : "Everything else", label: "Executors, in order (comma separated)", help, value: rule.executors.join(", "), required: "Name at least one executor.", submit: value => save(rules.map((r, j) => j === i ? { ...r, executors: splitList(value) } : r), "Routing saved") } } } : undefined;
    const remove: Act | undefined = canSet && !last ? { label: "Remove rule", danger: true, effect: save(rules.filter((_, j) => j !== i), "Rule removed"), confirm: { title: `Remove rule ${i + 1}?`, body: [`${rule.kinds?.join(", ")} → ${rule.executors.join(", ")}`], yes: "Remove" } } : undefined;
    items.push({ id, primary: edit, actions: defined([remove, addRule]), keys: { ...(addRule ? { n: addRule } : {}), ...(remove ? { x: remove } : {}) } });
    rows.push({ item: id, line: cols([
      { content: rule.kinds ? [span(`Rule ${i + 1}  `, { fg: "muted" }), span(rule.kinds.join(", "), { bold: true })] : [span("Everything else", { bold: true })], width: w[0]! },
      { content: rule.executors.map(x => executorLabel(x)).join(` ${glyph(ctx.theme, "→")} `), width: w[1]!, style: { fg: "secondary" } },
    ], GAP, ctx.theme) });
  });
  if (addRule) {
    rows.push(blank());
    items.push({ id: "rule-add", primary: addRule, actions: [], keys: { n: addRule } });
    rows.push({ item: "rule-add", line: [span("+ Add rule", { fg: "secondary" })] });
  }
  return { rows, items };
};

const projects: Build = (ctx, width) => {
  const rows: Row[] = [], items: Item[] = [], resource = ctx.data.settings.projects;
  const ops = ["project.strategy.list", "project.strategy.set", "project.strategy.remove"];
  if (!ops.every(op => ctx.supports(op))) return { rows: [unsupported("project.strategy.*")], items };
  rows.push(...wrap("Choose which executors may work on a repository, in order. This overrides global routing and stays in place when you switch strategies.", width).map(text => ({ line: [span(text, { fg: "secondary" })] })), blank());
  const pending = resourceState(ctx, resource);
  if (pending) return { rows: [...rows, ...pending], items };
  const list = Array.isArray(resource!.value) ? resource!.value : [];
  const editFor = (repo: { key: string; label: string }, rev: number, current: string[], available: { reference: string; label: string }[]): Act => ({
    label: "Edit project order",
    effect: { type: "prompt", prompt: { title: `Project strategy · ${repo.label}`, label: "Allowed executors, first choice first (comma separated)", value: current.join(", "), help: available.length ? `Available: ${available.map(a => a.reference).join(", ")}` : undefined, required: "Add at least one executor to save a project order. Use global strategy to remove an override.", submit: value => ({ type: "action", action: { label: "Project strategy saved", op: "project.strategy.set", params: { repo: repo.key, executors: splitList(value), expect_rev: rev } } }) } },
  });
  const configured = new Set(list.map(p => p.repo.key));
  const others = (ctx.s.repos ?? []).filter(r => !configured.has(r.key));
  const add: Act | undefined = others.length ? { label: "Add project order", effect: { type: "choose", title: "Project repository", options: others.map(r => ({ ...editFor(r, 0, [], list[0]?.available ?? []), label: r.label })) } } : undefined;
  if (!list.length) rows.push(empty(ctx.s.repos?.length ? "Every repository uses the global strategy." : "No repositories yet. Add a repository from the repository picker to configure its strategy."));
  const w = flex(width, [{ fixed: 20 }, { weight: 1, min: 10 }]);
  for (const p of list) {
    const id = `project:${p.repo.key}`;
    const refs = p.executors ?? [];
    const label = (ref: string) => p.available.find(a => a.reference === ref || a.id === ref)?.label ?? `${ref} (unavailable in the active strategy)`;
    const global: Act = { label: "Use global strategy", danger: true, effect: { type: "action", action: { label: "Using global strategy", op: "project.strategy.remove", params: { repo: p.repo.key, expect_rev: p.rev } } }, confirm: { title: `Use the global strategy for ${p.repo.label}?`, body: ["The project order is removed."], yes: "Use global strategy" } };
    items.push({ id, primary: editFor(p.repo, p.rev, refs, p.available), actions: defined([global, add]), keys: { x: global, ...(add ? { n: add } : {}) } });
    rows.push({ item: id, line: cols([
      { content: p.repo.label, width: w[0]!, style: { bold: true } },
      { content: refs.length ? refs.map((r, i) => `${i === 0 ? "First choice" : `Fallback ${i}`}: ${label(r)}`).join(` ${glyph(ctx.theme, "·")} `) : "Using global strategy", width: w[1]!, style: { fg: "secondary" } },
    ], GAP, ctx.theme) });
  }
  if (add) {
    rows.push(blank());
    items.push({ id: "project-add", primary: add, actions: [], keys: { n: add } });
    rows.push({ item: "project-add", line: [span("+ Add project order", { fg: "secondary" })] });
  }
  return { rows, items };
};

const strategies: Build = (ctx, width) => {
  const rows: Row[] = [], items: Item[] = [], resource = ctx.data.settings.strategies;
  if (!ctx.supports("strategy.list")) return { rows: [unsupported("strategy.list")], items };
  rows.push({ line: [span("Saved sets of everything above. Switch anytime.", { fg: "secondary" })] }, blank());
  const pending = resourceState(ctx, resource);
  if (pending) return { rows: [...rows, ...pending], items };
  const build: Act | undefined = ctx.supports("strategy.build") ? { label: "New from a brief", effect: { type: "prompt", prompt: { title: "New strategy", label: "What should this strategy do?", help: "Opens a planning session or returns a command to run.", required: "Describe the strategy first.", submit: brief => ({ type: "action", action: { label: "Strategy planning", op: "strategy.build", params: { brief } } }) } } } : undefined;
  const list = Array.isArray(resource!.value) ? resource!.value : [];
  if (!list.length) rows.push(empty("No strategies yet."));
  const w = flex(width, [{ fixed: 20 }, { fixed: 10 }, { weight: 1, min: 10 }]);
  for (const st of list) {
    const id = `strategy:${st.name}`;
    const use = st.active ? undefined : opAct(ctx, "Use", "strategy.use", { name: st.name });
    items.push({ id, primary: use, actions: defined([build]), keys: build ? { n: build } : {} });
    rows.push({ item: id, line: cols([
      { content: st.name, width: w[0]!, style: { bold: true } },
      { content: st.active ? statusSpans(ctx.theme, { label: "Active", tone: "good", glyph: "✓" }) : "", width: w[1]! },
      { content: st.summary, width: w[2]!, style: { fg: "secondary" } },
    ], GAP, ctx.theme) });
  }
  if (build) {
    rows.push(blank());
    items.push({ id: "strategy-new", primary: build, actions: [], keys: { n: build } });
    rows.push({ item: "strategy-new", line: [span("+ New from a brief", { fg: "secondary" })] });
  }
  return { rows, items };
};

const updates: Build = (ctx, width) => {
  const rows: Row[] = [], items: Item[] = [], resource = ctx.data.settings.update, config = ctx.data.settings.config;
  if (!ctx.supports("update.check")) return { rows: [unsupported("update.check")], items };
  const pending = resourceState(ctx, resource, "Checking for updates…");
  const check = opAct(ctx, "Check now", "update.check", { force: true });
  if (pending) {
    items.push({ id: "update:check", primary: check, actions: [], keys: {} });
    return { rows: pending.map(r => ({ ...r, item: "update:check" })), items };
  }
  const u = resource!.value!;
  const state = { failed: "Update check failed", disabled: "Update checking disabled", available: `Update available: ${u.latest}`, current: "Up to date", unchecked: "Not checked" }[updateState(u)];
  items.push({ id: "update:check", primary: check, actions: [], keys: {} });
  rows.push({ item: "update:check", line: field(ctx, width, "Version", [span(u.current, { bold: true }), span(`  ${state}`, { fg: u.available ? "warn" : u.error ? "bad" : "secondary" })], "⏎ check now") });
  const apply = u.available ? opAct(ctx, "Update and restart", "update.apply", {}, { confirm: { title: "Update pacer and restart the service?", yes: "Update and restart" } }) : undefined;
  if (apply) {
    items.push({ id: "update:apply", primary: apply, actions: [], keys: { u: apply } });
    rows.push({ item: "update:apply", line: field(ctx, width, "", [span("Update and restart", { fg: "warn", bold: true })]) });
  }
  const configured = config?.value?.keys?.update_check?.value !== false;
  if (u.disabled && configured) {
    // The strategy allows checks, so the environment turned them off; the toggle cannot change that.
    rows.push({ line: field(ctx, width, "Check for updates", [span("Off", { bold: true })], "PACER_NO_UPDATE_CHECK is set") });
  } else {
    const toggle = set(ctx, "Update checks", "update_check", !configured);
    items.push({ id: "update:daily", primary: toggle, actions: [], keys: {} });
    rows.push({ item: "update:daily", line: field(ctx, width, "Check for updates", [span(configured ? "On" : "Off", { bold: true })], "once a day, in the background") });
  }
  return { rows, items };
};

const notifications: Build = (ctx, width) => {
  const rows: Row[] = [], items: Item[] = [], resource = ctx.data.settings.notifications;
  if (!ctx.supports("notifications.get")) return { rows: [unsupported("notifications.get")], items };
  const pending = resourceState(ctx, resource);
  if (pending) return { rows: pending, items };
  const level = String(resource!.value!.level ?? "important"), ids = LEVELS.map(l => l[0]);
  const change = (step: number) => opAct(ctx, "Notifications", "notifications.set", { level: cycle(ids, level, step) });
  const next = change(1), prev = change(-1);
  items.push({ id: "setting:notifications", primary: next, actions: [], keys: { ...(prev ? { left: prev } : {}), ...(next ? { right: next } : {}) } });
  rows.push({ item: "setting:notifications", line: field(ctx, width, "Notify me about", LEVELS.flatMap(([id, label], i): Line => [...(i ? [span("  ")] : []), span(id === level ? `[${label}]` : label, id === level ? { fg: "focus", bold: true } : { fg: "muted" })])) });
  rows.push({ line: field(ctx, width, "", [span("Important: failures, stuck tasks and reviews.", { fg: "muted" })]) });
  return { rows, items, hints: ["← → change"] };
};

const appearance: Build = (ctx, width) => {
  const rows: Row[] = [], items: Item[] = [], t = ctx.theme;
  const flow = (label: string, key: string): Act => ({ label, effect: { type: "flow", name: "appearance", params: { key } } });
  const entry = (id: string, label: string, value: string, act?: Act, note?: string) => {
    if (act) items.push({ id, primary: act, actions: [], keys: { left: act, right: act } });
    rows.push({ ...(act ? { item: id } : {}), line: field(ctx, width, label, [span(value, { bold: true })], note) });
  };
  entry("appearance:theme", "Theme", t.appearance === "light" ? "Light" : "Dark", flow("Switch theme", "theme"), "truecolor and 256-color terminals");
  entry("appearance:color", "Colors", { truecolor: "Truecolor", "256": "256 colors", "16": "16 colors", none: "No color" }[t.depth], flow("Switch colors", "color"));
  entry("appearance:motion", "Motion", t.motion ? "On" : "Off", flow("Switch motion", "motion"), "spinners while loading");
  entry("appearance:glyphs", "Glyphs", t.unicode ? "Unicode" : "ASCII", flow("Switch glyphs", "glyphs"));
  rows.push(blank(), ...wrap("Applied for this session. To keep a choice, set PACER_THEME=light|dark, PACER_COLOR=none|16|256|truecolor or NO_COLOR, PACER_ASCII=1 and PACER_NO_ANIM=1, or run pacer dashboard --plain for screen readers.", width).map(text => ({ line: [span(text, { fg: "muted" })] })));
  return { rows, items };
};

const BUILDERS: Record<string, Build> = { planner, accounts, executors, machine, hosts, routing, projects, strategies, updates, notifications, appearance };
const BADGES = (ctx: ScreenCtx): Record<string, [string, "warn" | "bad"] | undefined> => {
  const down = (ctx.s.executors ?? []).filter(e => ["down", "failing"].includes(e.state)).length;
  const hostIssues = (ctx.s.hosts ?? []).filter(h => ["down", "needs_setup"].includes(h.state)).length;
  const signin = (ctx.s.accounts ?? []).filter(a => a.signedIn === false).length;
  return { executors: down ? [`${down} down`, "bad"] : undefined, hosts: hostIssues ? [`${hostIssues} needs setup`, "warn"] : undefined, accounts: signin ? [`${signin} sign-in`, "warn"] : undefined };
};

export function settingsScreen(ctx: ScreenCtx): ScreenView {
  const { theme } = ctx, listWidth = ctx.wide ? 30 : ctx.width;
  const sectionId = SECTIONS.some(s => s.id === ctx.state.section) ? ctx.state.section : "planner";
  const badges = BADGES(ctx);
  const list: Row[] = SECTIONS.map(section => {
    const active = section.id === sectionId, badge = badges[section.id];
    // While keys move inside the section, the list has no selection marker; mark the open section without colour.
    const mark = ctx.state.focus === "detail" ? [span(active ? `${glyph(theme, "▸")} ` : "  ", { fg: "focus", bold: true })] : [];
    return {
      item: `section:${section.id}`,
      line: [...mark, span(section.label, active ? { fg: "ink", bold: true } : { fg: "secondary" }), ...(badge ? [span(` ${badge[0]}`, { fg: badge[1] })] : [])],
    };
  });
  const width = (ctx.wide ? ctx.width - listWidth - 3 : ctx.width) - MARK;
  const section = SECTIONS.find(s => s.id === sectionId)!;
  const built = BUILDERS[section.id]!(ctx, width);
  const detail: Row[] = [{ line: heading(theme, section.label) }, blank(), ...built.rows];
  return { list, detail, listWidth, items: built.items, sections: SECTIONS.map(s => s.id), settingsNeeds: section.needs, hints: ctx.state.focus === "detail" ? [...(built.hints ?? []), "Esc sections"] : [] };
}
