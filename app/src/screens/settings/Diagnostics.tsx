import {SettingsPath} from "./PathText";
import { recordDiagnostics } from "../../data/diagnostics-status";
import { diagnosticDetail, diagnosticNextStep, settingsText } from "./presentation";
import { NativeValidationSetup } from "./NativeValidation";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Check } from "../../../../src/install/doctor";
import { diagnosticEvidence, diagnosticLevel, diagnosticsPage, diagnosticTitle, remedyPlan, remedyProgress, type DiagnosticFixRow, type DiagnosticRowOutcome, type DiagnosticTask, type RemedyPlan } from "../../../../src/view-model/diagnostics";
import { displayName } from "../../../../src/view-model/format";
import { executorLabel } from "../../../../src/view-model/words";
import { agentInfo, markAgent } from "../../../../src/view-model/agents";
import { commitRun, dispatchRemedy, openRemedyUrl, prepareRun, recheckOnReturn, type AgentConnectUndo, type ConsentRequest, type PreparedRun, type RemedyHost, type PreviewFile, type RepairPreview } from "../../data/remedies";
import { useActions } from "../../data/action-context";
import { platform } from "../../platform";
import { Button, ButtonLink } from "../../ds/Button";
import { DisclosurePanel } from "../../ds/Page";
import { DiagnosticRow } from "../../ds/DiagnosticRow";
import { Pill } from "../../ds/Pill";
import { RadioCard, RadioGroup } from "../../ds/Composer";
import { SectionHeading } from "../../ds/SectionHeading";
import { SideDialog } from "../../ds/SideDialog";
import { Disclosure } from "../../ds/Controls";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { time, useSettingsStyles } from "./shared";
import { PageHead } from "../../shell/slots";

export interface DoctorReport { checkedAt: number; durationSeconds?: number; checks: Check[]; planner?: string; repairAvailable?: boolean }

const REPORT_NOTE = "Configuration and fixture tests do not prove hook invocation. It stays unverified until observed in the planner.";
/** The confirmation key for the "Couldn't check" group and for Fix all. */
const INTERNAL = "\u0000internal", FIX_ALL = "\u0000fix-all";
/** Confirmation key for undo a repair from a review sheet. */
const UNDO = "\u0000undo";
const glyphs = {good: "✓", warn: "!", bad: "✕", neutral: "–"} as const;
function diagnosticTiming(report: DoctorReport): string {
  const checked = time(report.checkedAt);
  return `Last run ${/^\d{2}:\d{2}$/.test(checked) ? `today ${checked}` : checked}${report.durationSeconds != null ? ` · took ${report.durationSeconds < 1 ? "<1" : Math.round(report.durationSeconds)}s` : ""}`;
}
export function diagnosticReportText(report: DoctorReport): string {
  return [`Diagnostics · ${diagnosticTiming(report)}`, ...report.checks.map(check =>
    `${diagnosticLevel[check.level].label}: ${settingsText(diagnosticTitle(check.name))}${check.evidence ? ` · ${diagnosticEvidence[check.evidence]}` : ""}\n${diagnosticDetail(check)}${check.fix ? `\nSuggested next step: ${diagnosticNextStep(check.fix)}` : ""}${check.remedy ? `\nFix: ${check.remedy.label}` : ""}\nTechnical details: ${check.detail}${check.fix ? `\nReported recovery instructions: ${check.fix}` : ""}`), REPORT_NOTE].join("\n\n");
}

export interface PendingConsent { key: string; requests: ConsentRequest[]; resolve: (ok: boolean) => void }
interface ResultsProps {
  report: DoctorReport;
  baseline?: readonly string[];
  outcomes?: Readonly<Record<string, DiagnosticRowOutcome>>;
  tasks?: readonly DiagnosticTask[];
  /** True while a check run or a remedy is in progress; other remedy buttons wait. */
  busy?: boolean;
  consent?: PendingConsent;
  internalProgress?: string;
  onRemedy?: (row: DiagnosticFixRow, plan: RemedyPlan, secondary?: boolean) => void;
  onRestart?: () => void;
  onCopyReport?: () => void;
}

/**
 * One confirmation for every consent-gated change a click would make; consent is sent only after Confirm.
 * Focus moves into it so keyboard users reach Confirm next, and returns to the control that asked.
 */
function ConsentConfirm({ consent }: { consent: PendingConsent }) {
  const single = consent.requests.length === 1 ? consent.requests[0] : undefined;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const invoking = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => { if (invoking?.isConnected && invoking !== document.body) invoking.focus(); };
  }, []);
  return <div ref={ref} tabIndex={-1} className="pc-diagnostic-confirm" role="group" aria-label={single?.title ?? "Confirm changes"}>
    {consent.requests.map(request => <div key={request.title} className="pc-diagnostic-confirm__item">
      <b>{settingsText(request.title)}</b>
      <span>{request.message}</span>
      {request.files.length > 0 && <ul>{request.files.map(file => <li key={file}><SettingsPath path={file}/></li>)}</ul>}
    </div>)}
    <div className="pc-diagnostic-confirm__actions">
      <Button size="sm" onClick={() => consent.resolve(true)}>{single?.confirmLabel ?? "Confirm and fix"}</Button>
      <Button size="sm" variant="ghost" onClick={() => consent.resolve(false)}>Cancel</Button>
    </div>
  </div>;
}

function FixRow({ row, busy, consent, onRemedy }: { row: DiagnosticFixRow; busy: boolean; consent?: PendingConsent; onRemedy?: ResultsProps["onRemedy"] }) {
  const title = settingsText(row.title);
  const confirming = consent?.key === row.check.name ? consent : undefined;
  const task = row.task;
  const taskLink = task && <ButtonLink size="sm" variant="ghost" href={`#/tasks/${encodeURIComponent(task.taskId)}`}>Open task<span className="sr-only"> for {title}</span></ButtonLink>;
  const offered = !task?.open && row.plan && onRemedy;
  // A remedy in progress keeps its button mounted, so focus stays on it and sheets can return focus to it.
  const locked = busy || !!row.progress || !!confirming;
  const remedy = (plan: RemedyPlan, secondary?: boolean) => () => { if (!locked) onRemedy!(row, plan, secondary); };
  const action = row.fixed ? undefined : <>
    {task && <span className="pc-diagnostic-row__state" data-tone={task.tone}>{task.label}</span>}
    {row.progress && <span className="pc-diagnostic-caption">{row.progress}</span>}
    {offered && <Button size="sm" aria-disabled={locked || undefined} onClick={remedy(row.plan!)}>{row.remedy!.label}<span className="sr-only"> for {title}</span></Button>}
    {offered && row.secondary && <Button size="sm" variant="ghost" aria-disabled={locked || undefined} onClick={remedy(row.secondary.plan, true)}>{row.secondary.label}<span className="sr-only"> for {title}</span></Button>}
    {taskLink}
  </>;
  const problem = row.problem ?? (task?.detail ? `Still failing after the fix task: ${settingsText(task.detail)}` : undefined);
  return <DiagnosticRow title={title} caption={settingsText(row.detail)} kind={row.kind} tone={row.tone} glyph={row.glyph} status={row.status}
    action={action} notice={confirming ? <ConsentConfirm consent={confirming}/> : problem ? <p className="pc-diagnostic-row__problem">{problem}</p> : undefined}>
    <pre>{row.technical}</pre>
  </DiagnosticRow>;
}

function ResultRow({ check }: { check: Check }) {
  const unchecked = check.evidence === "unverified";
  const tone = unchecked ? "neutral" : diagnosticLevel[check.level].tone;
  const title = settingsText(diagnosticTitle(check.name));
  return <DiagnosticRow title={title} caption={`${diagnosticDetail(check)}${check.evidence ? ` · ${diagnosticEvidence[check.evidence]}` : ""}`}
    tone={tone} glyph={glyphs[tone]} status={unchecked ? "Not checked" : diagnosticLevel[check.level].label}>
    <pre>{check.detail}{check.fix ? `\n\nReported recovery instructions:\n${check.fix}` : ""}</pre>
  </DiagnosticRow>;
}

/** The Diagnostics board: summary, problems with one fix each, checks pacer could not run, and collapsed results. */
export function DiagnosticResults({ report, baseline, outcomes, tasks, busy = false, consent, internalProgress, onRemedy, onRestart, onCopyReport }: ResultsProps) {
  const page = diagnosticsPage({ checks: report.checks, baseline, outcomes, tasks });
  const internal = page.internal;
  return <div className="pc-diagnostic-results">
    <section aria-label="Summary" className="pc-diagnostic-summary">
      <p className="pc-diagnostic-summary__headline">{page.headline}</p>
      {page.support && <p>{page.support}</p>}
      {consent?.key === FIX_ALL && <ConsentConfirm consent={consent}/>}
    </section>
    {page.rows.length > 0 && <section aria-labelledby="diagnostics-needs-fix" className="pc-diagnostic-group">
      <SectionHeading id="diagnostics-needs-fix">Needs a fix · {page.openCount}</SectionHeading>
      <div className="pc-diagnostic-list pc-diagnostic-list--card">
        {page.rows.map(row => <FixRow key={row.check.name} row={row} busy={busy} consent={consent} onRemedy={onRemedy}/>)}
      </div>
    </section>}
    {internal && <section aria-labelledby="diagnostics-unchecked" className="pc-diagnostic-group">
      <SectionHeading id="diagnostics-unchecked">Couldn’t check · {internal.checks.length}</SectionHeading>
      <div className="pc-diagnostic-internal">
        <div className="pc-diagnostic-row__heading">
          <span className="pc-diagnostic-glyph pc-diagnostic-glyph--warn" aria-hidden="true">◐</span>
          <div className="pc-diagnostic-row__text">
            <b>{internal.title}</b>
            <span className="pc-diagnostic-row__detail">{internal.cause}</span>
            <ul className="pc-diagnostic-internal__checks">{internal.titles.map(title => <li key={title}>{settingsText(title)}</li>)}</ul>
          </div>
        </div>
        {consent?.key === INTERNAL && <ConsentConfirm consent={consent}/>}
        <div className="pc-diagnostic-internal__actions">
          {internalProgress && <span className="pc-diagnostic-caption">{internalProgress}</span>}
          {onRestart && <Button size="sm" aria-disabled={busy || consent?.key === INTERNAL || !!internalProgress || undefined}
            onClick={() => { if (!busy && consent?.key !== INTERNAL && !internalProgress) onRestart(); }}>{internal.remedy.label}</Button>}
          {onCopyReport && <Button size="sm" variant="ghost" onClick={onCopyReport}>Copy report<span className="sr-only"> to send to pacer</span></Button>}
        </div>
        <Disclosure className="pc-diagnostic-row__details" summary={<span>Technical details<span className="sr-only"> for checks pacer couldn’t run</span></span>}>
          <div className="pc-diagnostic-row__output"><pre>{internal.technical}</pre></div>
        </Disclosure>
      </div>
    </section>}
    {page.passed.length > 0 && <section aria-labelledby="diagnostics-passed" className="pc-diagnostic-group">
      <SectionHeading id="diagnostics-passed">Passed · {page.passed.length}</SectionHeading>
      <DisclosurePanel summary={<span className="pc-diagnostic-collapsed"><span className="pc-diagnostic-glyph pc-diagnostic-glyph--good" aria-hidden="true">✓</span><span>{settingsText(page.passedSummary)}</span><span className="pc-diagnostic-caption">Show all</span></span>}>
        <div className="pc-diagnostic-list">{page.passed.map(check => <ResultRow key={check.name} check={check}/>)}</div>
      </DisclosurePanel>
    </section>}
    {page.information.length > 0 && <section aria-labelledby="diagnostics-information" className="pc-diagnostic-group">
      <SectionHeading id="diagnostics-information">Information and not checked · {page.information.length}</SectionHeading>
      <DisclosurePanel summary={<span className="pc-diagnostic-collapsed"><span className="pc-diagnostic-glyph pc-diagnostic-glyph--neutral" aria-hidden="true">–</span><span>Results that need no fix</span><span className="pc-diagnostic-caption">Show all</span></span>}>
        <div className="pc-diagnostic-list">{page.information.map(check => <ResultRow key={check.name} check={check}/>)}</div>
      </DisclosurePanel>
    </section>}
  </div>;
}

type ReviewState = { check: Check; preview: RepairPreview; phase: "review" | "applying" | "done" | "error"; error?: unknown; resolve?: (ok: boolean) => void; undo?: AgentConnectUndo };
/** Board 17b (SettingsDiagnosticsReview) pills: how each file changes on apply. */
const CHANGE_PILL: Record<PreviewFile["change"], { label: string; tone: "good" | "warn" | "bad" | "info" | "neutral" }> = {
  create: { label: "Create", tone: "info" },
  update: { label: "Update", tone: "neutral" },
  restore: { label: "Restore", tone: "warn" },
  unchanged: { label: "No change", tone: "neutral" },
  kept: { label: "Not touched", tone: "neutral" },
};
/** Review changes: every file the reconnect writes, its change, the 7-day undo note and an Undo once applied. */
export function ReviewSheet({ review, report, onApply, onUndo, undoing = false, consent, onClose }: { review: ReviewState; report?: DoctorReport; onApply: () => void; onUndo?: () => void; undoing?: boolean; consent?: PendingConsent; onClose: () => void }) {
  const agent = displayName(review.preview.agent);
  const title = settingsText(diagnosticTitle(review.check.name));
  const current = report?.checks.find(check => check.name === review.check.name);
  const passes = !current || current.level === "ok" || current.level === "info";
  const files = review.preview.files ?? [];
  const changes: PreviewFile[] = (review.preview.changes?.length ?? 0) > 0
    ? review.preview.changes!
    : review.preview.files.map(path => ({ path, change: "update" as const, note: "Pacer updates its entries and keeps your edits." }));
  const changeCount = changes.filter(file => file.change !== "kept").length;
  if (review.phase === "done") {
    const undoAvailable = !!review.undo?.available;
    return <SideDialog title={`${agent} reconnected`} close={onClose}
      footer={<>{undoAvailable && <Button variant="ghost" aria-disabled={undoing || !!consent || undefined} onClick={onUndo}>{undoing ? "Restoring…" : "Undo"}</Button>}
        <Button variant="primary" onClick={onClose}>Back to Diagnostics</Button></>}>
      <p role="status" className="pc-diagnostic-sheet-text">{`Updated ${files.length === 1 ? "1 file" : `${files.length} files`} and rechecked: ${title} ${passes ? "passes" : "still needs attention"}.`}
        {passes && " Hooks show as verified after your next session with this agent."}</p>
      {undoAvailable
        ? <p className="pc-diagnostic-note">Pacer keeps the previous copies, so you can undo this from Diagnostics for 7 days.</p>
        : <p className="pc-diagnostic-note">{`Undo isn't available for this fix: ${review.undo?.reason ?? "no pacer file changes to undo"}.`}</p>}
      {consent && <ConsentConfirm consent={consent}/>}
    </SideDialog>;
  }
  return <SideDialog title={`Reconnect ${agent}`} close={onClose}
    footer={<><Button onClick={onClose} disabled={review.phase === "applying"}>Cancel</Button>
      {review.phase !== "error" && <Button variant="primary" busy={review.phase === "applying"} onClick={onApply}>{review.phase === "applying" ? "Fixing and rechecking…" : "Apply and recheck"}</Button>}</>}>
    <p className="pc-diagnostic-caption">{title}</p>
    <p className="pc-diagnostic-sheet-text">{`Pacer restores its own files for ${agent}. Nothing else in your folder changes.`}{review.preview.detail ? ` ${settingsText(review.preview.detail)}` : ""}</p>
    <SectionHeading as="h3">{changeCount === 1 ? "1 file changes" : `${changeCount} files change`}</SectionHeading>
    <ul className="pc-diagnostic-changes">
      {changes.map((file, index) => <li key={`${file.path}:${index}`} className="pc-diagnostic-change">
        <div className="pc-diagnostic-change__text"><span><SettingsPath path={file.path}/></span><span className="pc-diagnostic-caption">{settingsText(file.note)}</span></div>
        <Pill tone={CHANGE_PILL[file.change].tone}>{CHANGE_PILL[file.change].label}</Pill>
      </li>)}
    </ul>
    <p className="pc-diagnostic-note">Pacer keeps the current copies. You can undo this from Diagnostics for 7 days.</p>
    <ErrorMessage error={review.error}/>
  </SideDialog>;
}

/** The executor pacer would route the fix task to (board 17c). Read-only: pacer chooses it and there is no Change override control. */
export interface RoutedExecutor { id: string; reason: string }
type AgentState = { check: Check; scope: "fix" | "investigate"; phase: "compose" | "starting" | "started"; error?: unknown; taskId?: string; resolve?: (ok: boolean) => void };
const SCOPES = {
  fix: { title: "Fix it, ask before changing anything else", note: "Repairing the failing tool or integration goes ahead. Changes to other tools or your settings wait for you.", short: "asks before other changes" },
  investigate: { title: "Investigate only", note: "The agent finds the cause and proposes a fix. Nothing on your machine changes.", short: "investigate only" },
} as const;
/** Fix with agent: the service builds the brief from its own doctor result; the client sends only the check and scope. */
export function AgentSheet({ agent, report, routed, onScope, onStart, onClose }: { agent: AgentState; report?: DoctorReport; routed?: RoutedExecutor; onScope: (scope: AgentState["scope"]) => void; onStart: () => void; onClose: () => void }) {
  const title = settingsText(diagnosticTitle(agent.check.name));
  if (agent.phase === "started" && agent.taskId) return <SideDialog title="Fix task started" close={onClose}
    footer={<><Button onClick={onClose}>Back to Diagnostics</Button><ButtonLink variant="primary" href={`#/tasks/${encodeURIComponent(agent.taskId)}`} onClick={onClose}>Open task</ButtonLink></>}>
    <div className="pc-diagnostic-task" role="status"><b>{`${agent.scope === "fix" ? "Fix" : "Investigate"}: ${title}`}</b><Pill tone="info">Working</Pill><span className="pc-diagnostic-caption">{SCOPES[agent.scope].short}</span></div>
    <p className="pc-diagnostic-sheet-text">When you accept the task, pacer reruns this check. The row shows it as fixed only after the check passes.</p>
  </SideDialog>;
  const goal = agent.scope === "fix" ? `Make the check “${title}” pass.` : `Find why the check “${title}” fails and propose a fix.`;
  return <SideDialog title="Fix with agent" close={onClose}
    footer={<><Button onClick={onClose} disabled={agent.phase === "starting"}>Cancel</Button><Button variant="primary" busy={agent.phase === "starting"} onClick={onStart}>Start fix task</Button></>}>
    <p className="pc-diagnostic-caption">{title}</p>
    <p className="pc-diagnostic-sheet-text">Pacer has no built-in fix for this, so it starts a task with everything the check found. You review the result like any other task.</p>
    <SectionHeading as="h3">The agent gets</SectionHeading>
    <pre className="pc-diagnostic-brief">{[`Goal: ${goal}`, `Check: ${title} (${diagnosticLevel[agent.check.level].label.toLowerCase()}${report ? `, ${diagnosticTiming(report).replace(/^Last run /, "checked ").replace(/ · took.*$/, "")}` : ""})`,
      agent.check.detail, "Attached: related checks, the agent’s version and install path."].join("\n")}</pre>
    <p className="pc-diagnostic-note">Pacer builds the final brief from its own check result and removes keys and tokens before the agent sees it.</p>
    <SectionHeading as="h3">Runs on</SectionHeading>
    {routed
      ? <div className="pc-diagnostic-route"><span className="pc-diagnostic-route__mark" aria-hidden="true">{agentInfo(markAgent(routed.id)).monogram}</span>
        <div className="pc-diagnostic-route__text"><b>{executorLabel(routed.id)}</b><span className="pc-diagnostic-caption">Chosen by pacer: {routed.reason}</span></div>
      </div>
      : <p className="pc-diagnostic-sheet-text">Pacer routes it to an executor by budget and pace, like any task.</p>}
    <SectionHeading as="h3" id="diagnostics-agent-scope">What it may change</SectionHeading>
    <RadioGroup label="What it may change" aria-labelledby="diagnostics-agent-scope" className="pc-diagnostic-scopes">
      {(["fix", "investigate"] as const).map(scope => <RadioCard key={scope} checked={agent.scope === scope} disabled={agent.phase === "starting"}
        onSelect={() => onScope(scope)} title={SCOPES[scope].title} sub={SCOPES[scope].note}/>)}
    </RadioGroup>
    <ErrorMessage error={agent.error}/>
  </SideDialog>;
}

const errorText = (error: unknown) => settingsText(error instanceof Error ? error.message : String(error));
const issueNames = (checks: Check[]) => checks.filter(check => check.level === "warn" || check.level === "fail").map(check => check.name);
const stillFailing = (report: DoctorReport, name: string) => issueNames(report.checks).includes(name);

export function DiagnosticsSection() {
  useSettingsStyles();
  const {api, state} = useTaskContext();
  const runner = useActions();
  const call: RemedyHost["call"] = (op, params) => runner ? runner.call(op, params) : api.call(op, params);
  const [report, setReport] = useState<DoctorReport>();
  const [baseline, setBaseline] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, DiagnosticRowOutcome>>({});
  const [consent, setConsent] = useState<PendingConsent>();
  const [review, setReview] = useState<ReviewState>();
  const [agent, setAgent] = useState<AgentState>();
  const [routed, setRouted] = useState<RoutedExecutor>();
  const [started, setStarted] = useState<Record<string, DiagnosticTask>>({});
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [copyError, setCopyError] = useState<unknown>();
  const [progress, setProgress] = useState("No checks run yet.");
  /** Rows waiting for the person to come back; one focus listener rechecks them all. */
  const waiting = useRef(new Set<string>());
  const returnListener = useRef<() => void>();
  const runButton = useRef<HTMLButtonElement>(null);
  useEffect(() => () => returnListener.current?.(), []);
  /** When the focused control went away (a fixed row, the last fix-all), keep focus on the page. */
  const keepFocus = () => requestAnimationFrame(() => {
    if (!document.activeElement || document.activeElement === document.body) runButton.current?.focus();
  });
  const snapshotTasks = (state.snapshot?.tasks ?? []) as DiagnosticTask[];
  const tasks = [...snapshotTasks, ...Object.values(started).filter(task => !snapshotTasks.some(item => item.id === task.id))];
  const outcome = (name: string, next?: DiagnosticRowOutcome) => setOutcomes(current => {
    const { [name]: _previous, ...rest } = current;
    return next ? { ...rest, [name]: next } : rest;
  });

  function record(next: DoctorReport) {
    setReport(next);
    recordDiagnostics(next.checks.filter(check => check.level === "fail" || check.level === "warn").length);
  }
  async function readReport() {
    const begun = performance.now();
    const next = await call<DoctorReport>("doctor.run", {});
    return { ...next, durationSeconds: (performance.now() - begun) / 1000 };
  }
  async function runChecks() {
    if (running || busy) return;
    returnListener.current?.(); returnListener.current = undefined; waiting.current.clear();
    setRunning(true); setError(undefined); setProgress("Running checks…");
    try {
      const next = await readReport();
      record(next); setBaseline(issueNames(next.checks)); setOutcomes({});
      setProgress("");
    } catch (failure) { setError(failure); setProgress("Checks failed. Try running checks again."); }
    finally { setRunning(false); keepFocus(); }
  }
  /** Rerun every check after a fix; the row order stays that of the last full run. */
  async function recheck(): Promise<DoctorReport | undefined> {
    setRunning(true);
    try { const next = await readReport(); record(next); return next; }
    catch (failure) { setError(failure); setProgress("The recheck failed. Run all checks again when pacer is reachable."); return undefined; }
    finally { setRunning(false); }
  }
  function ask(key: string, requests: ConsentRequest[]): Promise<boolean> {
    return new Promise(resolve => setConsent({ key, requests, resolve: ok => { setConsent(undefined); resolve(ok); } }));
  }
  function host(check: Check, progressText: string): RemedyHost {
    return {
      call,
      confirm: async request => {
        outcome(check.name);
        const ok = await ask(check.name, [request]);
        if (ok) outcome(check.name, { phase: "running", text: progressText });
        return ok;
      },
      review: preview => new Promise(resolve => {
        outcome(check.name, { phase: "running", text: "Waiting for your review…" });
        setProgress("");
        setReview({ check, preview, phase: "review", resolve: ok => {
          setReview(current => current && (ok ? { ...current, phase: "applying", resolve: undefined } : undefined));
          if (ok) outcome(check.name, { phase: "running", text: "Updating files and rechecking…" });
          resolve(ok);
        } });
      }),
      delegate: () => new Promise(resolve => {
        outcome(check.name, { phase: "running", text: "Waiting for you to start the task…" });
        setProgress("");
        setRouted(undefined);
        setAgent({ check, scope: "fix", phase: "compose", resolve });
        // Read-only preview of where the fix task would go, with the same kind ("debug") and
        // scratch-repo routing semantics doctor.fix.delegate uses (no project selection).
        void (async () => {
          try {
            const result = await call<{ ranked?: { id: string; reason?: string }[] }>("routing.route", { kind: "debug" });
            const top = result.ranked?.[0];
            setRouted(top?.id ? { id: top.id, reason: top.reason ?? "It ranked first among the executors that can take this work." } : undefined);
          } catch { /* Routing stays unknown; the sheet keeps its generic line. */ }
        })();
      }),
      open: url => openRemedyUrl(url, platform),
      // runRemedy wraps this host with reportUndo to capture agent.connect's undo
      // availability for the done sheet; this bare default keeps host() a RemedyHost.
      reportUndo: () => {},
    };
  }
  function awaitReturn(name: string) {
    waiting.current.add(name);
    if (returnListener.current) return;
    returnListener.current = recheckOnReturn(() => {
      returnListener.current = undefined;
      const names = [...waiting.current];
      waiting.current.clear();
      void recheck().then(next => {
        for (const item of names) outcome(item, next ? { phase: "rechecked" } : undefined);
        // Replace the "rechecking when you return" status; recheck() reports its own failure.
        if (next) setProgress("Checked again after you came back. The rows show the new results.");
      });
    });
  }
  async function runRemedy(row: DiagnosticFixRow, plan: RemedyPlan, secondary = false) {
    if (busy || running) return;
    const name = row.check.name;
    const remedy = row.remedy!;
    const text = remedyProgress(secondary ? { kind: remedy.kind, label: remedy.secondary!.label, op: remedy.secondary!.op, url: remedy.secondary!.url } : remedy);
    // A consent-gated change only reads what would change until the person confirms.
    const asks = (plan.kind === "run" || plan.kind === "signin") && !!plan.consent;
    const first = asks ? "Checking what will change…" : plan.kind === "review" ? remedyProgress(remedy) : text;
    setBusy(true); setError(undefined);
    outcome(name, { phase: "running", text: first });
    setProgress(`${settingsText(row.title)}: ${first}`);
    let undoAfterConnect: AgentConnectUndo | undefined;
    const remedyHost: RemedyHost = { ...host(row.check, text), reportUndo: undo => { undoAfterConnect = undo; } };
    try {
      const result = await dispatchRemedy(plan, remedyHost);
      if (result === "cancelled") { outcome(name); setProgress("No changes were made."); return; }
      if (result === "delegated") { outcome(name); setProgress(`${settingsText(row.title)}: fix task started.`); return; }
      if (result === "await-return") {
        outcome(name, { phase: "waiting", text });
        setProgress(`${settingsText(row.title)}: ${text}`);
        awaitReturn(name);
        return;
      }
      const rechecked = await recheck();
      if (rechecked) {
        outcome(name, { phase: "rechecked" });
        setProgress(`${settingsText(row.title)}: ${stillFailing(rechecked, name) ? "still failing after the fix. The new result is in the row." : "fixed and rechecked."}`);
      } else outcome(name);
      setReview(current => current?.check.name !== name ? current : rechecked ? { ...current, phase: "done", undo: undoAfterConnect ?? { available: false, reason: "no pacer file changes to undo" } }
        : { ...current, phase: "error", error: new Error("The files were updated, but the recheck failed. Run all checks again.") });
    } catch (failure) {
      outcome(name, { phase: "error", message: errorText(failure) });
      setProgress(`${settingsText(row.title)}: the fix did not finish.`);
      setReview(current => current?.check.name === name ? { ...current, phase: "error", error: failure } : current);
    } finally { setBusy(false); keepFocus(); }
  }
  /** Runs every remaining automatic fix one at a time after one confirmation for those that need consent, then rechecks once. */
  async function fixAll(rows: DiagnosticFixRow[]) {
    if (busy || running || !rows.length) return;
    setBusy(true); setError(undefined); setProgress("Checking what will change…");
    try {
      const prepared: { row: DiagnosticFixRow; run: PreparedRun }[] = [];
      for (const row of rows) {
        try { prepared.push({ row, run: await prepareRun(row.plan as Extract<RemedyPlan, { kind: "run" }>, call) }); }
        catch (failure) { outcome(row.check.name, { phase: "error", message: errorText(failure) }); }
      }
      const requests = prepared.flatMap(item => item.run.consent ? [item.run.consent] : []);
      if (requests.length && !await ask(FIX_ALL, requests)) { setProgress("No changes were made."); return; }
      for (const { row } of prepared) outcome(row.check.name, { phase: "running", text: remedyProgress(row.remedy!) });
      for (const { row, run } of prepared) {
        setProgress(`${settingsText(row.title)}: ${remedyProgress(row.remedy!)}`);
        try { await commitRun(run, call); outcome(row.check.name, { phase: "running", text: "Rechecking…" }); }
        catch (failure) { outcome(row.check.name, { phase: "error", message: errorText(failure) }); }
      }
      const rechecked = await recheck();
      for (const { row } of prepared) setOutcomes(current => {
        if (current[row.check.name]?.phase !== "running") return current;
        const { [row.check.name]: _running, ...rest } = current;
        return rechecked ? { ...rest, [row.check.name]: { phase: "rechecked" } } : rest;
      });
      if (rechecked) setProgress("Automatic fixes finished and checks refreshed. Review any remaining issues.");
    } finally { setBusy(false); keepFocus(); }
  }
  async function restart(remedy: NonNullable<Check["remedy"]>) {
    const plan = remedyPlan(remedy);
    if (busy || running || plan?.kind !== "run") return;
    setBusy(true); setError(undefined);
    try {
      const run = await prepareRun(plan, call);
      if (run.consent && !await ask(INTERNAL, [run.consent])) { setProgress("No changes were made."); return; }
      outcome(INTERNAL, { phase: "running", text: "Restarted · rechecking…" });
      setProgress("Restarting the pacer service…");
      await commitRun(run, call);
      if (await recheck()) setProgress("The pacer service restarted and checks were refreshed.");
    } catch (failure) { setError(failure); setProgress("The restart did not finish."); }
    finally { outcome(INTERNAL); setBusy(false); keepFocus(); }
  }
  async function startAgentTask() {
    if (!agent || agent.phase !== "compose") return;
    const { check, scope } = agent;
    setAgent({ ...agent, phase: "starting", error: undefined });
    try {
      const result = await call<{ task: { task_id: string; state?: string } }>("doctor.fix.delegate", { check: check.name, scope });
      const id = result.task.task_id;
      setStarted(current => ({ ...current, [check.name]: { id, state: result.task.state ?? "queued", diagnosticCheck: check.name, updatedAt: Date.now() / 1000 } }));
      setAgent(current => current && { ...current, phase: "started", taskId: id, resolve: undefined });
      agent.resolve?.(true);
    } catch (failure) { setAgent(current => current && { ...current, phase: "compose", error: failure }); }
  }
  function closeAgent() {
    if (agent?.phase === "starting") return;
    agent?.resolve?.(false);
    setAgent(undefined);
    keepFocus();
  }
  function closeReview() {
    if (review?.phase === "applying") return;
    // Escape/close while an undo (or other) confirmation is open must cancel it, not
    // leave its promise pending; ask() clears consent through resolve(false).
    consent?.resolve(false);
    review?.resolve?.(false);
    setReview(undefined);
    keepFocus();
  }
  /** Undo exactly the last applied repair: confirm the snapshot's files, then restore or remove them. */
  async function undoRepair() {
    if (!review || review.phase !== "done" || busy || consent) return;
    const name = review.check.name;
    const agentName = review.preview.agent;
    let undoOption: RepairPreview["undoSnapshot"];
    try {
      const fresh = await call<RepairPreview>("agent.preview", { agent: agentName });
      undoOption = fresh.undoSnapshot;
    } catch (failure) {
      setError(failure);
      setProgress(`${settingsText(diagnosticTitle(name))}: could not prepare the undo.`);
      keepFocus();
      return;
    }
    const files = undoOption?.files.map(file => file.path) ?? [];
    if (!files.length) { setProgress("Nothing to undo."); setReview(undefined); keepFocus(); return; }
    const ok = await ask(UNDO, [{ title: `Undo the ${settingsText(diagnosticTitle(name))} repair`, message: "Pacer restores or removes exactly the files its last fix changed.", confirmLabel: "Restore copies", files }]);
    if (!ok) { setProgress("No changes were made."); return; }
    setBusy(true);
    try {
      const result = await call<{ restored: string[]; removed: string[]; kept: string[] }>("agent.undo", { agent: agentName, consent: true, preview_revision: undoOption!.revision });
      const next = await recheck();
      setReview(undefined);
      const counts = [
        result.restored.length ? `${result.restored.length} restored` : "",
        result.removed.length ? `${result.removed.length} removed` : "",
        result.kept.length ? `${result.kept.length} kept (changed since)` : "",
      ].filter(Boolean).join(", ");
      setProgress(`${settingsText(diagnosticTitle(name))} undone: ${counts || "no files changed"}. ${next && stillFailing(next, name) ? "The check still needs attention." : "Rechecked."}`);
    } catch (failure) {
      setError(failure);
      setProgress(`${settingsText(diagnosticTitle(name))}: the undo did not finish.`);
    } finally { setBusy(false); keepFocus(); }
  }
  async function copyReport() {
    if (!report) return;
    setCopyError(undefined);
    try { await navigator.clipboard.writeText(diagnosticReportText(report)); setProgress("Report copied."); }
    catch (failure) { setCopyError(failure); setProgress("Could not copy the report."); }
  }
  const page = report && diagnosticsPage({ checks: report.checks, baseline, outcomes, tasks });
  const autoLeft = page?.autoLeft ?? [];
  const locked = busy || running;
  return <><PageHead>
    <header className="pc-diagnostics-header">
      <div><h1>Diagnostics</h1><p className="pc-diagnostic-caption">Checks that pacer, your planner and every executor are wired up.{report && ` ${diagnosticTiming(report)}.`}</p></div>
      {report && <Button onClick={() => void copyReport()}>Copy report</Button>}
      <Button ref={runButton} variant={autoLeft.length ? "secondary" : "primary"} disabled={locked} aria-describedby={locked ? "diagnostics-progress" : undefined}
        onClick={() => void runChecks()}>Run all checks</Button>
      {autoLeft.length > 0 && <Button variant="primary" aria-disabled={locked || undefined} aria-describedby={locked ? "diagnostics-progress" : undefined}
        onClick={() => { if (!locked) void fixAll(autoLeft); }}>{page!.fixAllLabel}</Button>}
    </header>
  </PageHead>
  <section id="diagnostics" aria-label="Diagnostics" className="pc-diagnostics">
    <div role="status" aria-live="polite" id="diagnostics-progress" className={progress ? undefined : "sr-only"}>{progress}</div>
    <ErrorMessage error={error}/><ErrorMessage error={copyError}/>
    {report && <div aria-busy={locked}><DiagnosticResults report={report} baseline={baseline} outcomes={outcomes} tasks={tasks} busy={locked} consent={consent}
      internalProgress={outcomes[INTERNAL]?.phase === "running" ? (outcomes[INTERNAL] as {text: string}).text : undefined}
      onRemedy={(row, plan, secondary) => void runRemedy(row, plan, secondary)}
      onRestart={page?.internal ? () => void restart(page.internal!.remedy) : undefined}
      onCopyReport={() => void copyReport()}/></div>}
    <NativeValidationSetup/>
  </section>
  {review && <ReviewSheet review={review} report={report} onApply={() => review.resolve?.(true)} onUndo={() => void undoRepair()} undoing={busy} consent={consent?.key === UNDO ? consent : undefined} onClose={closeReview}/>}
  {agent && <AgentSheet agent={agent} report={report} routed={routed} onScope={scope => setAgent(current => current && { ...current, scope })} onStart={() => void startAgentTask()} onClose={closeAgent}/>}
  </>;
}
