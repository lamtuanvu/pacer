import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { RepoRef } from "../../../../src/api/read-model/types";
import { agentInfo } from "../../../../src/view-model/agents";
import { modeWords, paceStatus } from "../../../../src/view-model/words";
import { AgentMark } from "../../ds/AgentMark";
import { AttachmentPicker } from "../../ds/AttachmentTray";
import { Button, TextAction } from "../../ds/Button";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { CheckRow, DrillRow, FileChip, OptionRow, RadioCard, RadioChip, RadioGroup, Sheet, ValueBox } from "../../ds/Composer";
import { Disclosure, Field, TextArea, TextInput } from "../../ds/Controls";
import { Dialog } from "../../ds/Dialog";
import { Icon } from "../../ds/icons";
import { Kbd } from "../../ds/Kbd";
import { Page, PageTitle } from "../../ds/Page";
import { Card, LoadingState } from "../../ds/Patterns";
import { Pill } from "../../ds/Pill";
import { UsageMeter } from "../../ds/UsageMeter";
import { IssuePicker } from "./IssuePicker";
import { ApiError } from "../../data/api";
import { explainRoute, type ExplainResult, type RouteExplanation } from "../../data/explain-route";
import { filesFromPaste, insertPastedText, useAttachments } from "../../model/attachments";
import { draftStorage } from "../../model/draft";
import { routingStatus } from "../../model/executors";
import type { Routing } from "../../model/home";
import type { Account } from "../../model/accounts";
import {
  agentOptions, blankNewTask, kindChips, newTaskPayload, NEW_TASK_DRAFT_KEY, readChecks, readMentions, routeCard, savedNote, submitState,
  WORKSPACES, writeChecks, writeMentions, effectiveKind, retainedIssueSource, type AcceptanceCheck, type NewTaskDraft,
} from "../../model/new-task";
import { taskHref, type TaskSummary } from "../../model/tasks";
import { hrefFor, routes, type RouteQuery } from "../../router";
import { NARROW_MEDIA, activeRepo, useMedia } from "../../shell/narrow";
import { isApplePlatform } from "../../keys/registry";
import { handleDelegateKey } from "../Delegate";
import { useAction, useQuery, useTaskContext } from "../task-shared";

type RepoChoice = RepoRef & { branches?: string[] };
const lastRepo = () => { try { return JSON.parse(localStorage.getItem("pacer.delegate.last-repo") ?? "null")?.repo ?? ""; } catch { return ""; } };
const localDraft = () => draftStorage<NewTaskDraft>(NEW_TASK_DRAFT_KEY, blankNewTask, {
  getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key),
});
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const errorWords = (error: unknown) => error instanceof Error ? `${error.message}${error instanceof ApiError && error.hint ? ` ${error.hint}` : ""}` : String(error);

/** The draft lives in localStorage, so it survives a reload; every change is saved and stamped. */
function useNewTaskDraft(filterRepo: string | null) {
  const storage = useMemo(localDraft, []);
  const [draft, update] = useState<NewTaskDraft>(() => { const saved = storage.read(); return saved.repo || !filterRepo ? saved : { ...saved, repo: filterRepo }; });
  const [savedAt, setSavedAt] = useState<number | null>(() => storage.read().request ? Date.now() : null);
  const current = useRef(draft);
  /** `quiet` changes (a default the composer picked itself) are stored without claiming the user's draft was saved. */
  const set = (change: Partial<NewTaskDraft> | ((previous: NewTaskDraft) => NewTaskDraft), quiet = false) => {
    const next = typeof change === "function" ? change(current.current) : { ...current.current, ...change };
    next.issueSource = retainedIssueSource(next);
    if (!next.issueSource) next.issueText = "";
    current.current = next; storage.write(next); update(next);
    if (!quiet) setSavedAt(Date.now());
  };
  const save = () => { storage.write(current.current); setSavedAt(Date.now()); };
  const clear = () => { current.current = blankNewTask; storage.clear(); update(blankNewTask); setSavedAt(null); };
  return { draft, latest: () => current.current, set, save, clear, savedAt };
}

/**
 * The live "Will go to" preview. Typing refreshes 400 ms after the last keystroke; repository, kind and override
 * changes refresh at once. Replies older than the latest request are dropped, and a failed refresh keeps the last
 * explanation, marked out of date. `fresh` is the explanation only while it was computed for the current repository and
 * request, so a stale reply never decides the kind that is submitted.
 */
function useRoutePreview(input: { repo: string; goal: string; kind: string; executor: string }) {
  const { api, state } = useTaskContext();
  const [goal, setGoal] = useState(input.goal.trim());
  useEffect(() => { const t = setTimeout(() => setGoal(input.goal.trim()), 400); return () => clearTimeout(t); }, [input.goal]);
  const [result, setResult] = useState<{ last: RouteExplanation | null; for: string; unavailable: boolean; error: unknown; loading: boolean }>({ last: null, for: "", unavailable: false, error: undefined, loading: false });
  const sequence = useRef(0);
  useEffect(() => {
    const mine = ++sequence.current;
    if (!goal || !input.repo) { setResult(r => ({ ...r, last: null, for: "", loading: false, error: undefined })); return; }
    const key = JSON.stringify([input.repo, goal]);
    setResult(r => ({ ...r, loading: true }));
    void explainRoute(api, state.features.ops, { repo: input.repo, goal, kind: input.kind, executor: input.executor }).then((reply: ExplainResult) => {
      if (mine !== sequence.current) return;
      setResult(r => reply.state === "ok" ? { last: reply.explanation, for: key, unavailable: false, error: undefined, loading: false }
        : reply.state === "unavailable" ? { last: null, for: "", unavailable: true, error: undefined, loading: false }
        : { ...r, error: reply.error, loading: false });
    });
  }, [api, state.features.ops, input.repo, goal, input.kind, input.executor, state.connected]);
  // A refresh for the same request (an override or a reconnect) keeps the detected kind; new text or another repo drops it.
  const fresh = result.for === JSON.stringify([input.repo, input.goal.trim()]) ? result.last : null;
  return { ...result, fresh, empty: !input.goal.trim() };
}

export function NewTask({ query }: { query: RouteQuery }) {
  const { api, state } = useTaskContext();
  const narrow = useMedia(NARROW_MEDIA);
  const { draft, latest, set, save, clear, savedAt } = useNewTaskDraft(activeRepo(query));
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const repos = useQuery<RepoChoice[]>("repo.list", {});
  const choices = Array.isArray(repos.data) ? repos.data : [];
  const repo = choices.find(r => r.key === draft.repo);
  useEffect(() => {
    if (draft.repo || !choices.length) return;
    const last = lastRepo();
    set({ repo: (choices.find(r => r.key === last) ?? choices[0]!).key }, true);
  }, [choices.length]);
  const base = draft.base || repo?.branches?.[0] || "";
  const routing = useQuery<Routing>("routing.route", draft.repo ? { repo: draft.repo } : {});
  const accounts = useQuery<Account[]>("account.list", {});
  const preview = useRoutePreview({ repo: draft.repo, goal: draft.request, kind: draft.kind, executor: draft.executor });
  const uploads = useAttachments(api, draft.draftId, id => set({ draftId: id }));
  const action = useAction();
  const [issuePicker, setIssuePicker] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  // A new id whenever the goal or repository changes; a retry of the same request keeps it, so the service deduplicates.
  const requestId = useMemo(newId, [draft.request.trim(), draft.repo]);
  const checks = readChecks(draft), mentions = readMentions(draft);
  const planner = state.snapshot?.planner ?? null;
  const card = preview.last ? routeCard(preview.last, accounts.data ?? [], planner) : null;
  const pending = uploads.items.some(item => item.status !== "ready");
  const failed = !!failure;
  const submit = submitState({ draft, repoLabel: repo?.label, busy: action.busy, failed, pendingUploads: pending });
  const apple = isApplePlatform();

  const delegate = () => {
    if (submit.disabled) return;
    // The latest draft, so a change made in the same keystroke (⌘↵ in the mention field adds the path) is sent.
    const current = latest();
    const next = submit.retryInWorktree ? { ...current, workspace: "worktree" } : current;
    if (submit.retryInWorktree) set({ workspace: "worktree" });
    let params;
    try {
      params = newTaskPayload(next, { requestId, knownRepos: choices.map(r => r.key), attachments: uploads.items.filter(i => i.status === "ready"), explanation: preview.fresh });
    } catch (error) { setFailure(error); return; }
    setFailure(undefined);
    void action.run<TaskSummary>("task.delegate", params, task => {
      try { localStorage.setItem("pacer.delegate.last-repo", JSON.stringify({ repo: next.repo })); } catch { /* storage unavailable */ }
      clear(); location.hash = taskHref(task.task_id);
    });
  };
  useEffect(() => { if (action.error) setFailure(action.error); }, [action.error]);
  const cancel = () => { location.hash = hrefFor(routes.tasks(), query); };

  const props: ViewProps = { canImportIssue: state.features.ops.has("issue.import"), onIssue: () => setIssuePicker(true), draft, set, base, repo, choices, preview, card, routing: routing.data, accounts: accounts.data ?? [], uploads, checks, mentions, submit, failure, apple, planner, mode: state.snapshot?.mode?.mode ?? planner?.mode ?? "", lastRepo: lastRepo(), onDelegate: delegate, onSave: save, onCancel: cancel, note: savedNote(savedAt, now, failed), onUseWorktree: () => { set({ workspace: "worktree" }); setFailure(undefined); } };
  return <>{narrow ? <NewTaskSheet {...props} /> : <NewTaskPage {...props} />}
    {issuePicker && state.features.ops.has("issue.import") && <IssuePicker repo={draft.repo} canSearch={state.features.ops.has("issue.search")} close={() => setIssuePicker(false)}
      onImport={issue => { set({ request: [latest().request.trim(), issue.title, issue.body].filter(Boolean).join("\n\n"), issueSource: [latest().issueSource, issue.url].filter(Boolean).join(", "), issueText: [latest().issueText, issue.title, issue.body].filter(Boolean).join("\n\n") }); setIssuePicker(false); }} />}
  </>;
}

interface ViewProps {
  canImportIssue: boolean; onIssue: () => void;
  draft: NewTaskDraft; set: (change: Partial<NewTaskDraft>) => void; base: string; repo?: RepoChoice; choices: RepoChoice[];
  preview: ReturnType<typeof useRoutePreview>; card: ReturnType<typeof routeCard> | null; routing?: Routing; accounts: Account[];
  uploads: ReturnType<typeof useAttachments>; checks: AcceptanceCheck[]; mentions: string[]; submit: ReturnType<typeof submitState>;
  failure: unknown; apple: boolean; planner: import("../../../../src/api/read-model/types").PlannerMeter | null; mode: string; lastRepo: string; note: string;
  onDelegate: () => void; onSave: () => void; onCancel: () => void; onUseWorktree: () => void;
}

function formKeys(p: ViewProps) {
  return (event: KeyboardEvent) => handleDelegateKey(event, p.onDelegate, p.submit.disabled);
}
function onPaste(p: ViewProps) {
  return (event: ClipboardEvent) => {
    const files = filesFromPaste(event);
    if (!files.length) return;
    event.preventDefault();
    const input = event.currentTarget as HTMLTextAreaElement;
    p.set({ request: insertPastedText(input.value, event.clipboardData?.getData("text/plain") ?? "", input.selectionStart, input.selectionEnd) });
    p.uploads.uploadFiles(files);
  };
}

function RequestBox({ p, rows, compact }: { p: ViewProps; rows: number; compact?: boolean }) {
  const [mentioning, setMentioning] = useState(false), [path, setPath] = useState("");
  const add = () => { const value = path.trim().replace(/^@/, ""); if (value) p.set({ mentions: writeMentions([...p.mentions, value]) }); setPath(""); setMentioning(false); };
  const chips = p.uploads.items.length > 0 || p.mentions.length > 0;
  // The composer opens ready to type, on the route and inside the narrow sheet alike.
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  return <div className={`pc-request-box${p.draft.request.trim() && !p.failure ? " pc-request-box--filled" : ""}`} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); p.uploads.uploadFiles(Array.from(event.dataTransfer?.files ?? [])); }}>
    <TextArea ref={input} id="nt-request" rows={rows} value={p.draft.request} className="pc-request-box__input" aria-describedby="nt-request-help"
      placeholder="e.g. Make remote-support access opt-out, and update the settings copy and docs"
      onInput={event => p.set({ request: event.currentTarget.value })} onPaste={onPaste(p)} />
    {retainedIssueSource(p.draft) && <span className="pc-caption pc-issue-source" role="note">Imported from issue: {retainedIssueSource(p.draft)} · Untrusted text. Review it before delegating. <Button variant="quiet" size="sm" onClick={() => p.set({ issueSource: "", issueText: "" })}>Remove source</Button></span>}
    {chips && <div className="pc-request-box__chips">
      {p.uploads.items.map(item => <FileChip key={item.id} removeLabel={`Remove ${item.name}`} onRemove={() => void p.uploads.remove(item.id)}>
        <Icon name="image" /><span className="pc-file-chip__name" title={item.name}>{item.name}</span>
        <span className="pc-caption">{item.status === "uploading" ? "Uploading…" : item.status === "error" ? item.error ?? "Upload failed" : `${Math.ceil(item.size / 1024)} KB`}</span>
      </FileChip>)}
      {p.mentions.map(path => <FileChip key={path} mono removeLabel={`Remove ${path}`} onRemove={() => p.set({ mentions: writeMentions(p.mentions.filter(m => m !== path)) })}>
        <span className="pc-file-chip__at">@</span><span className="pc-file-chip__name" title={path}>{path}</span>
      </FileChip>)}
    </div>}
    {mentioning && <div className="pc-request-box__mention">
      <TextInput autoFocus aria-label="File or folder in the repository" className="mono" placeholder="src/remote/access.ts" value={path}
        onInput={event => setPath(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); add(); if (!(event.metaKey || event.ctrlKey)) event.stopPropagation(); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMentioning(false); } }} />
      <Button size="sm" onClick={add} disabled={!path.trim()}>Add</Button>
      <Button size="sm" variant="ghost" onClick={() => setMentioning(false)}>Cancel</Button>
    </div>}
    <div className="pc-request-box__tools">
      <AttachmentPicker variant="tool" onFiles={p.uploads.uploadFiles} label={<><Icon name="attach" /><span className="pc-request-box__tool-word">Attach</span></>} accessibleLabel="Attach a file" />
      <Button variant="quiet" size="sm" className="pc-request-box__tool" aria-label="Mention a file or folder" onClick={() => setMentioning(true)}><span className="pc-request-box__at" aria-hidden="true">@</span><span className="pc-request-box__tool-word">File or folder</span></Button>
      {p.canImportIssue && <Button variant="quiet" size="sm" className="pc-request-box__tool" onClick={p.onIssue} aria-label="From an issue" disabled={!p.repo}><Icon name="issue" /><span className="pc-request-box__tool-word">From an issue</span></Button>}
      {p.canImportIssue && !p.repo && <span className="pc-caption">Choose a repository to import an issue</span>}
      <span className="grow" />
      <span className="pc-caption pc-request-box__hint">{p.uploads.items.length || p.mentions.length ? `${p.uploads.items.length + p.mentions.length} file${p.uploads.items.length + p.mentions.length === 1 ? "" : "s"} attached` : compact ? "" : "Drop files here · images, logs, specs up to 25 MiB per file"}</span>
    </div>
  </div>;
}

function KindField({ p }: { p: ViewProps }) {
  const chips = kindChips(p.draft, p.preview.fresh);
  const chosen = effectiveKind(p.draft, p.preview.fresh);
  const note = p.draft.kind ? "chosen by you" : chosen ? `detected: ${chosen.value} · change it if pacer guessed wrong` : p.preview.empty ? "detected from the request" : "pick one, or pacer starts without a kind";
  return <div className="pc-new-task__field">
    <span className="pc-new-task__label" id="nt-kind-label">Kind <span className="pc-caption pc-new-task__label-note">· {note}</span></span>
    <RadioGroup label="Kind" className="pc-new-task__kinds">
      {chips.map(chip => <RadioChip key={chip.kind} checked={chip.on} note={chip.detected ? "detected" : undefined} onSelect={() => p.set({ kind: chip.kind })}>{chip.label}</RadioChip>)}
    </RadioGroup>
  </div>;
}

function WorkspaceChoices({ p }: { p: ViewProps }) {
  return <RadioGroup label="Where it runs" className="pc-new-task__workspaces">
    {WORKSPACES.map(w => <RadioCard key={w.id} checked={(p.draft.workspace || "worktree") === w.id} onSelect={() => p.set({ workspace: w.id })} title={w.title} tag={w.tag}
      sub={w.id === "current" && p.repo ? `Writes to ${p.repo.path} directly` : w.sub} />)}
  </RadioGroup>;
}

function Checks({ p }: { p: ViewProps }) {
  const [adding, setAdding] = useState(false), [text, setText] = useState(""), [command, setCommand] = useState("");
  const write = (next: AcceptanceCheck[]) => p.set({ checks: writeChecks(next) });
  const add = () => {
    if (!text.trim() && !command.trim()) return;
    write([...p.checks, { id: globalThis.crypto?.randomUUID?.() ?? String(Date.now()), text: text.trim() || command.trim(), command: command.trim(), on: true }]);
    setText(""); setCommand(""); setAdding(false);
  };
  return <div className="pc-new-task__checks">
    {!p.checks.length && !adding && <span className="pc-caption pc-new-task__checks-empty">No checks yet. Add a command such as <code>bun run test</code> to make it required.</span>}
    {p.checks.map(check => <CheckRow key={check.id} checked={check.on} label={check.text} detail={check.command && check.command !== check.text ? check.command : undefined} source="Added by you"
      onToggle={() => write(p.checks.map(c => c.id === check.id ? { ...c, on: !c.on } : c))}
      actions={<Button variant="quiet" size="sm" aria-label={`Remove check: ${check.text}`} className="pc-icon-button" onClick={() => write(p.checks.filter(c => c.id !== check.id))}><Icon name="close" /></Button>} />)}
    {adding ? <div className="pc-new-task__check-form" onKeyDown={event => { if (event.key === "Enter" && !(event.metaKey || event.ctrlKey)) { event.preventDefault(); add(); } }}>
      <Field label="What must be true"><TextInput autoFocus value={text} placeholder="Settings copy says it is opt-out" onInput={event => setText(event.currentTarget.value)} /></Field>
      <Field label="Command (optional)"><TextInput className="mono" value={command} placeholder="bun run test" onInput={event => setCommand(event.currentTarget.value)} /></Field>
      <div className="pc-new-task__check-actions"><Button size="sm" onClick={add} disabled={!text.trim() && !command.trim()}>Add check</Button><Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button></div>
    </div> : <Button variant="quiet" size="sm" className="pc-new-task__add-check" onClick={() => setAdding(true)}><Icon name="plus" />Add a check</Button>}
  </div>;
}

function AgentChoices({ p }: { p: ViewProps }) {
  const options = agentOptions(p.routing, row => routingStatus(row as never), p.accounts);
  const plannerAgent = p.planner?.agent ?? "claude-code";
  return <RadioGroup label="Agent for this task" className="pc-new-task__agents">
    <OptionRow checked={!p.draft.executor} onSelect={() => p.set({ executor: "" })} leading={<AgentMark agent={plannerAgent} size={20} labelled={false} />}
      title="Let pacer decide" sub="Recommended · uses your dispatcher setup" pill={{ label: "Default", tone: "neutral" }} />
    {options.map(option => <OptionRow key={option.executor} checked={p.draft.executor === option.executor} disabled={!option.available}
      onSelect={() => p.set({ executor: option.executor })} leading={<AgentMark agent={option.agent} size={20} labelled={false} />}
      title={option.name} sub={option.sub} pill={option.pill} />)}
  </RadioGroup>;
}

function RouteBody({ p, compact }: { p: ViewProps; compact?: boolean }) {
  const { preview, card } = p;
  if (preview.empty) return <div className="pc-route-card__empty"><span className="pc-route-card__empty-title">Describe the task to see where it goes</span><span className="pc-caption">pacer picks the agent from the kind, each agent's budget, and your dispatcher setup.</span></div>;
  if (preview.unavailable) return <div className="pc-route-card__empty"><span className="pc-route-card__empty-title">Routing preview isn't available</span><span className="pc-caption">This pacer service can't explain routes yet. pacer still picks the agent from your dispatcher setup when you delegate.</span></div>;
  if (!card) return preview.error ? <span className="pc-caption">Couldn't check where it goes: {errorWords(preview.error)}</span> : <LoadingState label="Checking where it goes…" />;
  const reasons = <ul className={compact ? "pc-route-card__why pc-caption" : "pc-route-card__why"}>{(compact ? card.why.slice(0, 1) : card.why).map((y, i) => <li key={i}>{!compact && <span aria-hidden="true" className={`pc-route-card__glyph pc-route-card__glyph--${y.tone}`}>{y.glyph}</span>}<span className={compact ? "pc-ellipsis" : undefined} title={compact ? card.why.map(reason => reason.text).join(" · ") : undefined}>{y.text}</span></li>)}</ul>;
  return <>
    {card.lead ? <div className="pc-route-card__lead">
      <AgentMark agent={card.lead.agent} size={compact ? 32 : 36} />
      <div className="pc-route-card__who"><span className="pc-route-card__name">{card.lead.name}</span>{compact ? reasons : <span className="pc-caption">{card.lead.step}</span>}</div>
      <Pill tone={card.lead.pill.tone}>{card.lead.pill.label}</Pill>
    </div> : <span className="pc-route-card__name">{card.status.label}</span>}
    {(!compact || !card.lead) && reasons}
    {!compact && card.then.length > 0 && <div className="pc-route-card__then">
      <span className="pc-caption">If it can't:</span>
      {card.then.map(n => <span key={n.executor} className={`pc-route-card__fallback${n.excluded ? " pc-route-card__fallback--excluded" : ""}`} title={n.reason ?? undefined} tabIndex={n.excluded ? 0 : undefined}>
        <AgentMark agent={n.agent} size={18} labelled={false} />{n.name}{n.excluded && <span className="sr-only">, not available: {n.reason}</span>}
      </span>)}
    </div>}
    {preview.error && <span className="pc-caption">May be out of date: {errorWords(preview.error)}</span>}
  </>;
}

function PlannerRow({ p }: { p: ViewProps }) {
  const planner = p.planner;
  if (!planner || p.preview.empty) return null;
  const view = p.card?.planner ?? { cost: "Not measured yet", used: planner.usedPct, pace: planner.pacePct, note: planner.usedPct === null ? "" : `Week ${Math.round(planner.usedPct)}%${planner.pacePct === null ? "" : ` · pace ${Math.round(planner.pacePct)}%`}` };
  const name = agentInfo(planner.agent).name;
  return <div className="pc-route-card__planner">
    <span className="pc-route-card__planner-head"><AgentMark agent={planner.agent} size={18} labelled={false} /><span className="pc-route-card__planner-title">Planner cost</span><span className="pc-route-card__planner-cost">{view.cost}</span></span>
    <UsageMeter used={view.used} pace={view.pace} tone={paceStatus(planner.verdict).tone} verdict={planner.verdict} size="row" text="none" label={`${name} weekly usage`} />
    {view.note && <span className="pc-caption">{view.note}</span>}
  </div>;
}

function StrictNotice({ p }: { p: ViewProps }) {
  const mode = p.mode.toLowerCase();
  if (mode !== "strict" && mode !== "emergency") return null;
  const name = p.planner ? agentInfo(p.planner.agent).name : "The planner";
  const ahead = p.planner?.deltaPts && p.planner.deltaPts > 0 ? `${Math.round(p.planner.deltaPts)} points ahead of pace. ` : "";
  return <Card className="pc-card--warn pc-new-task__notice">
    <span aria-hidden="true" className="pc-new-task__notice-glyph pc-new-task__notice-glyph--warn">◐</span>
    <span className="pc-new-task__notice-text"><span className="pc-new-task__notice-title">{name} is in {modeWords(mode)} mode</span><span className="pc-caption">{ahead}Planning stays short. It still starts now.</span><TextAction className="pc-new-task__notice-link" href={hrefFor(routes.settings("planner"))}>Budget &amp; pacing</TextAction></span>
  </Card>;
}

function FailureNotice({ p }: { p: ViewProps }) {
  if (!p.failure) return null;
  return <div role="alert"><Card className="pc-card--bad pc-new-task__notice">
    <span aria-hidden="true" className="pc-new-task__notice-glyph pc-new-task__notice-glyph--bad">✕</span>
    <span className="pc-new-task__notice-text"><span className="pc-new-task__notice-title">pacer couldn't start this task</span><span className="pc-caption">{errorWords(p.failure)} Your request is kept as a draft.</span></span>
    {p.draft.workspace === "current" && <Button variant="primary" size="sm" onClick={p.onUseWorktree}>Use a new worktree</Button>}
    <Button size="sm" onClick={p.onDelegate} disabled={p.submit.disabled}>Try again</Button>
  </Card></div>;
}

function RepoPicker({ p, id }: { p: ViewProps; id?: string }) {
  return <ChoicePicker id={id} className="pc-new-task__pick" searchable value={p.draft.repo} placeholder="Choose a repository…"
    options={p.choices.map(r => ({ value: r.key, label: r.label, description: r.branches?.[0] }))} onValueChange={value => p.set({ repo: value, base: "", executor: "" })} />;
}
const repoHelp = (p: ViewProps) => {
  const others = Math.max(0, p.choices.length - 1);
  return [p.repo && p.repo.key === p.lastRepo ? "Last used" : "", `${others} other repo${others === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
};

function NewTaskPage(p: ViewProps) {
  const overrideOpen = !!p.draft.executor;
  return <Page width="full" className="pc-new-task">
    <header className="pc-new-task__header">
      <div className="pc-new-task__intro">
        <TextAction className="pc-new-task__crumb" href={hrefFor(routes.tasks())}>Tasks ›</TextAction>
        <PageTitle className="pc-new-task__title">New task</PageTitle>
        <span className="pc-caption">Describe the outcome. pacer plans it, sends it to the best available agent, and checks the result before you see it.</span>
      </div>
      <span className="pc-caption pc-new-task__saved" aria-live="polite">{p.note}</span>
      <Button onClick={p.onSave}>Save draft</Button>
      <Button variant="ghost" onClick={p.onCancel}>Cancel</Button>
    </header>
    <FailureNotice p={p} />
    <div className="pc-new-task__cols" onKeyDown={formKeys(p)}>
      <section aria-label="Task request" className="pc-new-task__form">
        <div className="pc-new-task__field">
          <label htmlFor="nt-request" className="pc-new-task__label">What should get done?</label>
          <RequestBox p={p} rows={6} />
          <span id="nt-request-help" className="pc-caption">{p.preview.empty ? "Say what “done” looks like. pacer turns it into acceptance checks you can edit below." : ""}</span>
        </div>
        <div className="pc-new-task__pair">
          <div className="pc-new-task__field">
            <label htmlFor="nt-repo" className="pc-new-task__label">Repository</label>
            <RepoPicker p={p} id="nt-repo" />
            <span className="pc-caption">{repoHelp(p)}</span>
          </div>
          <div className="pc-new-task__field">
            <span className="pc-new-task__label" id="nt-branch-label">Branch name</span>
            <ValueBox aria-labelledby="nt-branch-label" role="group" meta="Auto"><span className="mono">pacer/…</span></ValueBox>
            <span className="pc-caption">Made from the request; edit it if you like</span>
          </div>
        </div>
        <fieldset className="pc-new-task__fieldset">
          <legend className="pc-new-task__label">Where it runs</legend>
          <WorkspaceChoices p={p} />
        </fieldset>
        <KindField p={p} />
        <div className="pc-new-task__field">
          <span className="pc-new-task__label-row"><span className="pc-new-task__label">Acceptance checks</span><span className="pc-caption">Must pass before the result reaches you</span></span>
          <Checks p={p} />
        </div>
        <Disclosure className="pc-new-task__more" summary={<>More options <span className="pc-caption pc-new-task__label-note">· base branch {p.base || "current"}</span></>}>
          <div className="pc-new-task__more-body">
            <Field label="Base branch" help="The new worktree starts from this branch.">
              <ChoicePicker value={p.base} options={(p.repo?.branches ?? []).map(b => ({ value: b, label: b }))} placeholder="Current branch" onValueChange={value => p.set({ base: value })} />
            </Field>
          </div>
        </Disclosure>
      </section>
      <aside aria-label="Where this task goes" className="pc-new-task__aside">
        <section className="pc-route-card" aria-label="Will go to">
          <div className="pc-route-card__body">
            <span className="pc-route-card__head"><span className="pc-label">Will go to</span><span className="pc-caption" aria-live="polite">{p.card && !p.preview.error && !p.preview.empty ? "Updated as you type" : ""}</span></span>
            <RouteBody p={p} />
          </div>
          <PlannerRow p={p} />
        </section>
        <StrictNotice p={p} />
        <Disclosure className="pc-new-task__override" open={overrideOpen} summary={<>Send to a specific agent <span className="pc-caption pc-new-task__label-note">· this task only</span></>}>
          <AgentChoices p={p} />
        </Disclosure>
        <div className="pc-new-task__submit">
          <Button variant="primary" className="pc-new-task__delegate" disabled={p.submit.disabled} busy={false} onClick={p.onDelegate} aria-keyshortcuts={p.apple ? "Meta+Enter" : "Control+Enter"}>
            {p.submit.label}<Kbd>{p.apple ? "⌘↵" : "Ctrl+↵"}</Kbd>
          </Button>
          <span className="pc-caption pc-new-task__submit-note">{p.submit.note}</span>
        </div>
      </aside>
    </div>
  </Page>;
}

type SheetName = "repo" | "workspace" | "kind" | "checks" | "agent";
function NewTaskSheet(p: ViewProps) {
  const [open, setOpen] = useState<SheetName | null>(null);
  const on = p.checks.filter(c => c.on).length;
  const kind = effectiveKind(p.draft, p.preview.fresh);
  const agent = p.draft.executor ? agentOptions(p.routing, row => routingStatus(row as never), p.accounts).find(a => a.executor === p.draft.executor)?.name ?? p.draft.executor : "Let pacer decide";
  const titles: Record<SheetName, string> = { repo: "Repository", workspace: "Where it runs", kind: "Kind", checks: "Acceptance checks", agent: "Agent" };
  const plannerText = p.card ? [`Planner ${p.card.planner.cost}`, p.card.planner.note].filter(Boolean).join(" · ") : `Planner: not measured yet${p.planner?.usedPct == null ? "" : ` · week ${Math.round(p.planner.usedPct)}%`}`;
  return <Sheet title="New task" close={p.onCancel} className="pc-new-task-sheet"
    action={<Button variant="ghost" size="sm" onClick={p.onSave}>Save draft</Button>}
    footer={<><Button variant="primary" className="pc-new-task__delegate" disabled={p.submit.disabled} onClick={p.onDelegate}>{p.submit.label}</Button><span className="pc-caption pc-new-task__submit-note">{p.submit.disabled ? p.submit.note : p.failure ? p.submit.note : `Starts in ${p.draft.workspace === "current" ? "the current checkout" : "a new worktree"} on ${p.repo?.label ?? ""}`}</span></>}>
    <div className="pc-new-task-sheet__content" onKeyDown={formKeys(p)}>
      <FailureNotice p={p} />
      <div className="pc-new-task__field">
        <label htmlFor="nt-request" className="pc-new-task__label">What should get done?</label>
        <RequestBox p={p} rows={5} compact />
        <span id="nt-request-help" className="sr-only">{p.note}</span>
      </div>
      <section aria-label="Where this task goes" className="pc-route-card pc-route-card--compact">
        <div className="pc-route-card__body"><span className="pc-label">Will go to</span><RouteBody p={p} compact /></div>
        {p.planner && !p.preview.empty && <span className="pc-caption pc-ellipsis pc-route-card__compact-planner" title={plannerText}>{plannerText}</span>}
      </section>
      <StrictNotice p={p} />
      <div className="pc-new-task-sheet__rows">
        <DrillRow label="Repository" onClick={() => setOpen("repo")} value={<>{p.repo?.label ?? "Choose a repository"} {p.base && <span className="mono pc-new-task-sheet__muted">{p.base}</span>}</>} />
        <DrillRow label="Where it runs" onClick={() => setOpen("workspace")} value={WORKSPACES.find(w => w.id === (p.draft.workspace || "worktree"))!.title} />
        <DrillRow label="Kind" onClick={() => setOpen("kind")} value={kind ? <>{kind.value.charAt(0).toUpperCase() + kind.value.slice(1)} {kind.detected && <span className="pc-caption">· detected</span>}</> : "Not set"} />
        <DrillRow label="Acceptance checks" onClick={() => setOpen("checks")} value={p.checks.length ? `${on} of ${p.checks.length} on` : "None yet"} />
        <DrillRow label="Agent" onClick={() => setOpen("agent")} value={agent} />
      </div>
      <span className="pc-caption">Each row opens its own sheet with the same choices as the desktop form.</span>
    </div>
    {open && <Dialog title={titles[open]} close={() => setOpen(null)}>
      <div className="pc-new-task-sheet__choice">
        {open === "repo" && <><Field label="Repository" help={repoHelp(p)}><RepoPicker p={p} /></Field>
          <Field label="Base branch"><ChoicePicker value={p.base} options={(p.repo?.branches ?? []).map(b => ({ value: b, label: b }))} placeholder="Current branch" onValueChange={value => p.set({ base: value })} /></Field></>}
        {open === "workspace" && <WorkspaceChoices p={p} />}
        {open === "kind" && <KindField p={p} />}
        {open === "checks" && <Checks p={p} />}
        {open === "agent" && <AgentChoices p={p} />}
        <Button variant="primary" onClick={() => setOpen(null)}>Done</Button>
      </div>
    </Dialog>}
  </Sheet>;
}
