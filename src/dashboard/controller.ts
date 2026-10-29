/** The dashboard controller: holds state, reads through the API client, runs effects and draws frames. */
import { ApiError, type ApiClient } from "../api/client";
import type { Action } from "../attention/types";
import { emptySnapshot } from "../link/envelope";
import type { ClientSnapshot, ClientTask } from "../view-model/snapshot";
import { displayTitle } from "../view-model/titles";
import { jobKindCopy } from "../view-model/copy";
import type { StatusTone } from "../view-model/words";
import { renderFrame, screenView, tabs, type FrameInput } from "./screens/shell";
import { KINDS, scopedReviewQueue } from "./screens/review";
import type { DashData, Resource, SettingsData, TaskDetail, UpdateInfo } from "./screens/types";
import { initialState, reduceKey, type Act, type Effect, type ScreenId, type UiState } from "./state";
import type { TerminalTheme } from "./theme";
import { updateState, type UpdateState } from "./screens/common";
import type { SessionPreparation } from "../session/capabilities";
import { agentInfo } from "../view-model/agents";
import { machineStep, type MachineKey } from "./screens/settings";
import type { Message } from "../messaging/types";
import { threadMessages, type ThreadDetail } from "./screens/thread";

export interface ControllerDeps {
  client: ApiClient;
  theme: TerminalTheme;
  version: string;
  /** Unix seconds. */
  now(): number;
  size(): { width: number; height: number };
  write(frame: string): void;
  /** The directory a delegation defaults to. */
  cwd: string;
  /** Update state from the shared cached check, read without network. */
  update?(): UpdateState | undefined;
  /** Hand the terminal to a viewer for a builtin session. */
  attachHere?(id: string): Promise<void>;
  /** Hand the terminal to a pacer CLI command (account add, runner add) and resume afterwards. */
  handoff?(args: string[]): Promise<number>;
  timeZone?: string;
}

const SETTINGS_OPS: Record<keyof SettingsData, [string, Record<string, unknown>]> = {
  config: ["config.get", {}], accounts: ["account.list", {}], routing: ["routing.get", {}], projects: ["project.strategy.list", {}],
  strategies: ["strategy.list", {}], update: ["update.check", {}], notifications: ["notifications.get", {}],
};
/** Ops whose success changes settings resources. */
const SETTINGS_MUTATIONS = /^(config\.set|runner\.|account\.|routing\.set|project\.strategy\.(set|remove)|strategy\.(use|save|remove)|notifications\.set|update\.|host\.set)/;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Dashboard {
  state: UiState = initialState();
  snapshot: ClientSnapshot = emptySnapshot();
  ops: readonly string[] | undefined;
  connection: FrameInput["connection"] = "connecting";
  /** When the last successful snapshot read finished. */
  private readAt: number | undefined;
  theme: TerminalTheme;
  data: { history?: DashData["history"]; details: Map<string, Resource<ThreadDetail> & { stamp?: string; threadStamp?: string }>; settings: SettingsData } = { details: new Map(), settings: {} };
  /** `untilRead` keeps the message until the next successful read, then for the usual 5 s. */
  private message?: { text: string; tone: StatusTone; until: number; untilRead?: boolean };
  private frame = 0;
  private loading = 0;
  private inFlight?: Promise<void>;
  private settingsLoaded = new Set<keyof SettingsData>();

  private pending = new Set<Promise<unknown>>();

  constructor(public deps: ControllerDeps) { this.theme = deps.theme; }

  /** Resolve once every started read has finished (one-shot output and tests). */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  get busyLoading() { return this.loading > 0; }
  supports = (op: string) => this.ops === undefined || this.ops.includes(op);

  report(text: string, tone: StatusTone = "info") {
    const line = text.split(/\r?\n/).filter(Boolean).join(" · ");
    this.message = { text: line, tone, until: this.deps.now() + 5 };
    this.draw();
  }
  /** The service stopped answering and reads moved to the local client. The local read can be slow, so the
   * warning lasts until that read has drawn its first frame. */
  fallback() {
    this.message = { text: "pacer serve unavailable; working locally", tone: "warn", until: Infinity, untilRead: true };
    this.draw();
  }
  reportError(error: unknown) {
    if (error instanceof ApiError) this.report(`${error.message}${error.hint ? ` (${error.hint})` : ""}`, "bad");
    else this.report(error instanceof Error ? error.message : String(error), "bad");
  }

  input(): FrameInput {
    const { width, height } = this.deps.size(), now = this.deps.now();
    const message = this.message && this.message.until > now ? { text: this.message.text, tone: this.message.tone } : undefined;
    return {
      s: this.snapshot, now, theme: this.theme, state: this.state, width, height, ops: this.ops, data: this.data as DashData,
      version: this.deps.version, update: this.deps.update?.(), connection: this.connection, ...(this.readAt !== undefined ? { readAt: this.readAt } : {}),
      ...(message ? { message } : {}),
      ...(this.theme.motion && this.loading > 0 ? { spinner: SPINNER[this.frame % SPINNER.length] } : {}),
      ...(this.deps.timeZone ? { timeZone: this.deps.timeZone } : {}),
    };
  }
  render(): string { return renderFrame(this.input()); }
  /** A rendering bug must not take the terminal down: show it and keep the keys working. */
  draw() {
    let frame: string;
    try { frame = this.render(); }
    catch (error) { frame = `pacer dashboard could not draw this screen: ${error instanceof Error ? error.message : String(error)}\nPress 1 for Home, R to refresh or q to quit.`; }
    this.deps.write(frame);
  }
  tick() { this.frame++; if (this.loading > 0 && this.theme.motion) this.draw(); }

  /** Read hello and the snapshot; a single refresh runs at a time. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = Promise.all([this.deps.client.snapshot(), this.ops === undefined ? this.deps.client.hello() : Promise.resolve({ ops: this.ops })])
      .then(([result, hello]) => {
        this.ops = hello.ops;
        this.snapshot = result.snapshot as ClientSnapshot;
        this.connection = this.deps.client.kind === "http" ? "live" : "local";
        this.readAt = this.deps.now();
        if (this.message?.untilRead) this.message = { ...this.message, until: this.readAt + 5, untilRead: false };
        this.loadNeeds();
        this.draw();
      })
      .catch(error => {
        if (this.readAt !== undefined) { this.connection = "offline"; this.draw(); }
        this.reportError(error);
      })
      .finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  /** Fetch task detail and settings resources the visible view shows. */
  loadNeeds() {
    const { view, screen } = screenView(this.input());
    if (screen === "sessions" && !this.data.history && this.supports("task.list")) this.loadHistory();
    if (this.supports("task.get")) for (const id of view.needs ?? []) {
      const task = this.snapshot.tasks.find(t => t.id === id), stamp = `${task?.rev ?? ""}:${task?.updatedAt ?? ""}:${task?.state ?? ""}`;
      const current = this.data.details.get(id);
      if (current && (current.loading || current.stamp === stamp && (!current.value?.work || current.value.state!=="running"))) continue;
      this.data.details.set(id, { ...current, loading: true, stamp });
      this.track(this.deps.client.call<TaskDetail>("task.get", { id })
        .then(async value => { if(value.work&&this.supports("dispatch.tree")){try{value.workTree=await this.deps.client.call<NonNullable<TaskDetail["workTree"]>>("dispatch.tree",{id});}catch{}}const before=this.data.details.get(id);this.data.details.set(id, { ...before, value: { ...value, messages: threadMessages(before?.value) }, stamp, loading:false }); })
        .catch(error => { this.data.details.set(id, { ...this.data.details.get(id), loading: false, stamp, error: errorOf(error) }); }));
    }
    if (this.supports("msg.log")) for (const id of view.needs ?? []) {
      const task = this.snapshot.tasks.find(t => t.id === id);
      const seq = this.snapshot.seq;
      const current = this.data.details.get(id);
      const last = threadMessages(current?.value)?.value?.at(-1)?.id ?? "";
      const stamp = `${task?.rev ?? ""}:${task?.updatedAt ?? ""}:${task?.state ?? ""}:${seq}:${last}`;
      if (current?.threadStamp === stamp || threadMessages(current?.value)?.loading) continue;
      const value = current?.value ?? { id, state: task?.state ?? "unknown" };
      this.data.details.set(id, { ...current, value: { ...value, messages: { ...threadMessages(value), loading: true } }, threadStamp: stamp });
      this.track(this.deps.client.call<{ messages: Message[] }>("msg.log", { task: id })
        .then(result => { const before = this.data.details.get(id); if (!before) return;
          this.data.details.set(id, { ...before, value: { ...before.value!, messages: { value: result.messages } }, threadStamp: `${task?.rev ?? ""}:${task?.updatedAt ?? ""}:${task?.state ?? ""}:${seq}:${result.messages.at(-1)?.id ?? ""}` });
        })
        .catch(error => { const before = this.data.details.get(id); if (!before) return;
          this.data.details.set(id, { ...before, value: { ...before.value!, messages: { value: threadMessages(before.value)?.value, error: errorOf(error) } } });
        }));
    }
    if (screen === "settings") for (const key of view.settingsNeeds ?? []) {
      if (this.settingsLoaded.has(key)) continue;
      const [op, params] = SETTINGS_OPS[key];
      if (!this.supports(op)) continue;
      this.settingsLoaded.add(key);
      const before = this.data.settings[key] as Resource<unknown> | undefined;
      (this.data.settings as Record<string, Resource<unknown>>)[key] = { ...before, loading: true };
      this.track(this.deps.client.call(op, params)
        .then(value => { (this.data.settings as Record<string, Resource<unknown>>)[key] = { value }; })
        .catch(error => { (this.data.settings as Record<string, Resource<unknown>>)[key] = { ...before, loading: false, error: errorOf(error) }; }));
    }
  }
  private loadHistory(before?: string) {
    if(this.data.history?.loading || !this.supports("task.list"))return;
    const previous=this.data.history?.value;
    this.data.history={value:previous,loading:true};
    this.track(this.deps.client.call<{tasks:ClientTask[];next:string|null}>("task.list",{all:true,limit:20,...(before?{before}:{})})
      .then(value=>{this.data.history={value:{...value,tasks:[...new Map([...(before?previous?.tasks??[]:[]),...value.tasks].map(t=>[t.id,t])).values()]}};this.loadNeeds();})
      .catch(error=>{this.data.history={value:previous,error:errorOf(error)};}));
  }
  private track(work: Promise<unknown>) {
    this.loading++;
    const done = work.finally(() => { this.loading--; this.pending.delete(done); this.draw(); });
    this.pending.add(done);
  }
  invalidateSettings() { this.settingsLoaded.clear(); }
  /** A service event: re-read the snapshot, and the config a settings section shows when another client changed it. */
  event(event: { type: string }): Promise<void> {
    if (event.type === "config" || event.type === "reset") this.settingsLoaded.delete("config");
    return this.refresh();
  }

  /** Handle one key. Resolves "quit" when the dashboard should close. */
  async key(key: string): Promise<"quit" | void> {
    const input = this.input(), { view, ctx, screen } = screenView(input);
    if (key === "n" && !this.state.overlay && this.supports("session.create")) {
      this.state = {...this.state, overlay: {kind: "prompt", value: "", spec: {
        title: "Start an interactive session", label: "Request", required: "Describe what you want to work on.",
        submit: request => ({type: "prompt", prompt: {title: "Start an interactive session", label: "Repository path", value: this.deps.cwd, required: "Choose a repository.",
          submit: repo => ({type: "flow", name: "conversation-prepare", params: {request, repo}})}}),
      }}};
      this.draw(); return;
    }
    if (key === "d" && !this.state.overlay && this.supports("task.delegate")) { this.delegate(); this.draw(); return; }
    // Setup can be shown in place of the requested screen. Keys select and act on the rows shown, while the
    // requested screen is kept so finishing setup returns to it.
    const shown = { ...this.state, screen };
    const result = reduceKey(shown, key, {
      items: view.items, tabs: tabs(this.snapshot), sections: view.sections, page: Math.max(1, ctx.height - 2), wide: ctx.wide,
      hasDetail: !!view.detail, repos: (this.snapshot.repos ?? []).map(r => r.key), supports: this.supports, ...(view.initial ? { initial: view.initial } : {}),
    });
    this.state = result.state.screen === screen && screen !== this.state.screen ? { ...result.state, screen: this.state.screen } : result.state;
    if (result.quit) return "quit";
    if (result.refresh) { this.invalidateSettings(); this.data.details.clear(); this.data.history=undefined; await this.refresh(); this.report("Refreshed", "good"); return; }
    this.loadNeeds();
    this.draw();
    if (result.effect) await this.run(result.effect);
  }

  private navigate(screen: ScreenId, id?: string, section?: string) {
    const prefix: Partial<Record<ScreenId, string>> = { review: "review:", sessions: "session:" };
    const selected = { ...this.state.selected };
    if (id && screen !== "settings") selected[screen] = `${prefix[screen] ?? ""}${id}`;
    if (screen === "settings" && id) selected.settings = id;
    this.state = { ...this.state, screen, selected, focus: screen === "settings" && section ? "detail" : "list", scroll: 0, overlay: null, ...(section ? { section } : {}) };
    this.loadNeeds();
    this.draw();
  }

  async run(effect: Effect): Promise<void> {
    switch (effect.type) {
      case "history-more": this.loadHistory(this.data.history?.value?.next??undefined); return;
      case "navigate": this.navigate(effect.screen, effect.id, effect.section); return;
      case "local": this.report(effect.label); await effect.run(); return;
      case "action": await this.call(effect.action); return;
      case "attach": await this.attach(effect.id, effect.target); return;
      case "handoff": {
        if (!this.deps.handoff) { this.report(`Run: pacer ${effect.argv.join(" ")}`); return; }
        try {
          const code = await this.deps.handoff(effect.argv);
          this.report(code === 0 ? `${effect.label}: finished` : `${effect.label}: exited ${code}`, code === 0 ? "good" : "warn");
        } catch (error) { this.reportError(error); }
        this.invalidateSettings();
        await this.refresh();
        return;
      }
      case "flow": await this.flow(effect.name, effect.params); return;
      case "prompt": case "choose": return; // the reducer opens these as overlays
    }
  }

  private async call(action: Action) {
    try {
      // A conversation's progress can advance its revision while its end/resume
      // confirmation is open. Fetch the current revision just before the write.
      let params = action.params;
      if ((action.op === "session.end" || action.op === "session.resume") && typeof params.id === "string") {
        const current = await this.deps.client.call<{ rev: number }>("task.get", { id: params.id });
        params = { ...params, expect_rev: current.rev };
      }
      const result = await this.deps.client.call<Record<string, unknown> | null>(action.op, params);
      this.report(action.op === "config.set" && typeof result?.warning === "string" ? result.warning : successCopy(action, result), action.op === "config.set" && typeof result?.warning === "string" ? "warn" : "good");
      if (action.op === "task.review") this.afterReview(String(action.params.id));
    } catch (error) {
      if (error instanceof ApiError && error.code === "conflict" && action.op === "task.review") this.report("Another client already reviewed this task.", "warn");
      else this.reportError(error);
    }
    if (SETTINGS_MUTATIONS.test(action.op)) this.invalidateSettings();
    if (typeof action.params.id === "string") this.data.details.delete(action.params.id);
    await this.refresh();
  }
  private afterReview(id: string) {
    const queue = scopedReviewQueue({ s: this.snapshot, state: this.state }).filter(a => a.taskId !== id);
    const next = queue[0];
    if (next) this.state = { ...this.state, selected: { ...this.state.selected, review: `review:${next.taskId}` } };
    const verb = this.message?.text ?? "Done";
    const title = next ? this.snapshot.tasks.find(t => t.id === next.taskId) : undefined;
    this.report(next ? `${verb} · next: ${title ? displayTitle(title) : next.title}` : `${verb} · review queue is clear`, "good");
  }

  private async attach(id: string, target: "here" | "terminal" | "tmux") {
    try {
      if (target === "here") {
        const info = await this.deps.client.call<{ host: string }>("task.session", { id });
        if (info.host === "builtin" && this.deps.attachHere) { await this.deps.attachHere(id); await this.refresh(); return; }
      }
      const result = await this.deps.client.call<{ opened: boolean; command?: string }>("task.attach", { id, target: target === "here" ? "orca" : target });
      this.report(result.opened ? "Opened task session." : result.command ? `Run: ${result.command}` : `Run: pacer attach ${id}`, "good");
    } catch (error) { this.reportError(error); }
  }

  /** messaging.grants.user_started_tasks, read when the delegate prompt opens. */
  private userGrants: boolean | undefined;
  private delegate() {
    if (this.supports("msg.policy")) void this.deps.client.call<{ config?: { grants?: { user_started_tasks?: string } } }>("msg.policy", {})
      .then(p => { this.userGrants = p.config?.grants?.user_started_tasks !== "off"; }, () => { this.userGrants = undefined; });
    const scope = this.state.scope ? this.snapshot.repos?.find(r => r.key === this.state.scope)?.path : undefined;
    const repoDefault = scope ?? this.deps.cwd;
    this.state = { ...this.state, overlay: { kind: "prompt", value: "", spec: {
      title: "Delegate a task", label: "Goal", required: "Describe the goal first.", help: "The planner's brief: what done looks like.",
      submit: goal => ({ type: "prompt", prompt: {
        title: "Delegate a task", label: "Repository path", value: repoDefault, required: "Choose a repository.",
        submit: repo => ({ type: "prompt", prompt: {
          title: "Delegate a task", label: "Work type (optional)", help: `One of: ${KINDS.join(", ")}`,
          submit: kind => {
            const params = { goal, repo, source: "ui", ...(kind ? { kind } : {}) };
            // Offered only when the service turns user-started grants on; omitting grant follows that default.
            if (!this.userGrants) return { type: "action", action: { label: "Delegated", op: "task.delegate", params } };
            return { type: "prompt", prompt: {
              title: "Delegate a task", label: "Can coordinate sub-agents (y/n)", value: "y", help: "Yes lets the task start and message its own sub-agents.",
              submit: answer => ({ type: "action", action: { label: "Delegated", op: "task.delegate", params: { ...params, ...(/^n/i.test(answer.trim()) ? { grant: false } : {}) } } }),
            } };
          },
        } }),
      } }),
    } } };
  }

  private async flow(name: string, params: Record<string, unknown>) {
    if (name === "machine-step") {
      // The shown value can be older than a change made elsewhere: step from the value config.get reads now.
      const key = params.key as MachineKey, label = String(params.label);
      let fresh: NonNullable<NonNullable<SettingsData["config"]>["value"]>;
      try { fresh = await this.deps.client.call("config.get", {}); }
      catch (error) { this.reportError(error); return; }
      this.data.settings.config = { value: fresh };
      this.settingsLoaded.add("config");
      const value = machineStep(key, fresh.keys?.[key]?.value, params.step === -1 ? -1 : 1);
      if (value === undefined) { this.report(`${label} is already ${key === "execution.local_max_tasks" ? "No limit" : "Off"}.`, "warn"); return; }
      await this.call({ label, op: "config.set", params: { key, value } });
      return;
    }
    if (name === "conversation-prepare") {
      try {
        const prepared = await this.deps.client.call<SessionPreparation>("session.prepare", {repo: params.repo});
        const choices = prepared.executors.filter(e => e.available).map(e => ({label: `${agentInfo(e.agent).name} · ${e.account} · new from ${prepared.base}`,
          effect: {type: "flow" as const, name: "conversation-create", params: {...params, executor: e.id, base: prepared.base}}}));
        if (!choices.length) {this.report("No interactive executor is ready.", "warn"); return;}
        this.state = {...this.state, overlay: {kind: "menu", title: "Choose agent and account", actions: choices, index: 0}};
      } catch(error) {this.reportError(error);}
      return;
    }
    if (name === "conversation-create") {
      try {
        const draft = await this.deps.client.call<{id:string}>("session.draft.create", {});
        const result = await this.deps.client.call<{task_id:string}>("session.create", {request_id:crypto.randomUUID(),draftId:draft.id,request:params.request,repo:params.repo,executor:params.executor,workspace:{mode:"new",base:params.base},attachments:[]});
        this.navigate("sessions", result.task_id);this.report(`Session ${result.task_id} started. Enter to open the terminal.`, "good");
        await this.refresh();
      } catch(error) {this.reportError(error);}
      return;
    }
    if (name === "appearance") {
      const t = this.theme, key = params.key;
      const depths = ["truecolor", "256", "16", "none"] as const;
      this.theme = key === "theme" ? { ...t, appearance: t.appearance === "dark" ? "light" : "dark" }
        : key === "color" ? { ...t, depth: depths[(depths.indexOf(t.depth) + 1) % depths.length]! }
        : key === "motion" ? { ...t, motion: !t.motion }
        : key === "glyphs" ? { ...t, unicode: !t.unicode } : t;
      this.report("Applied for this session.", "good");
      return;
    }
    if (name === "connect-agent" || name === "change-planner") {
      const value = String(params.value ?? params.agent ?? ""), agent = value.split(/[#@]/)[0]!;
      let preview: { files: string[]; undo: string; detail?: string } | undefined;
      try { if (this.supports("agent.preview")) preview = await this.deps.client.call("agent.preview", { agent }); }
      catch (error) { this.reportError(error); return; }
      const body = [...(preview?.files.length ? ["Files to change:", ...preview.files.map(f => `  ${f}`)] : []), ...(preview?.detail ? [preview.detail] : []), ...(preview?.undo ? [`To undo: ${preview.undo}`] : []), "No MCP servers will be added."];
      const act: Act = name === "connect-agent"
        ? { label: `Connect ${agent}`, effect: { type: "action", action: { label: `Connected ${agent}`, op: "agent.connect", params: { agent, consent: true } } }, confirm: { title: `Connect ${agent}?`, body, yes: "Connect" } }
        : { label: "Change and connect", effect: { type: "action", action: { label: "Planner changed", op: "config.set", params: { key: "planner", value, integrations: "install" } } },
          confirm: { title: `Use ${value} as the planner?`, body, yes: "Change and connect", alt: { key: "o", label: "Change only", act: { label: "Change only", effect: { type: "action", action: { label: "Planner changed", op: "config.set", params: { key: "planner", value, integrations: "skip" } } } } } } };
      this.state = { ...this.state, overlay: { kind: "confirm", title: act.confirm!.title, body: act.confirm!.body ?? [], yes: act.confirm!.yes ?? act.label, act, ...(act.confirm!.alt ? { alt: act.confirm!.alt } : {}) } };
      this.draw();
    }
  }
}

function errorOf(error: unknown): NonNullable<Resource<unknown>["error"]> {
  if (error instanceof ApiError) return { message: error.message, ...(error.hint ? { hint: error.hint } : {}), code: error.code };
  return { message: error instanceof Error ? error.message : String(error) };
}

/** Plain result copy for each op; unknown ops report their label. */
function successCopy(action: Action, result: Record<string, unknown> | null): string {
  const r = result ?? {};
  const job = r.job as { id: string; kind?: string } | undefined;
  if (job) return `${action.label}: ${jobKindCopy(job.kind ?? action.op)} started`;
  switch (action.op) {
    case "task.delegate": return `Delegated · ${String(r.task_id)} queued`;
    case "task.retry": { const retry = r.retry as { task_id?: string } | undefined; return retry?.task_id ? `Retry queued · ${retry.task_id}` : "Retry queued"; }
    case "task.stop": return "Stopped";
    case "task.review": return action.label;
    case "onboarding.try": return `Started ${String(r.task_id)} on ${String(r.executor)}. Review it when it finishes.`;
    case "config.set": return `Saved.${r.undo ? ` Undo: ${String(r.undo)}` : ""}`;
    case "strategy.build": case "account.signin": case "runner.add": return r.opened ? `${action.label}: opened in a new terminal` : r.command ? `Run: ${String(r.command)}` : `${action.label}: done`;
    case "update.check": {
      // The same reading as the footer and Settings › Updates.
      const reading = updateState(r as unknown as UpdateInfo);
      return reading === "failed" ? `Update check failed: ${String(r.error)}` : reading === "disabled" ? "Update checks are off, so nothing was checked"
        : reading === "available" ? `Update available: ${String(r.latest)}` : reading === "current" ? "Up to date" : "Not checked";
    }
    case "task.dismiss": case "attention.dismiss": return "Dismissed";
    default: return `${action.label}: done`;
  }
}
