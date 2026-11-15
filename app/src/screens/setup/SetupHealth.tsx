import { useEffect, useRef } from "preact/hooks";
import type { SetupHealthRepair, SetupHealthReport, SetupHealthStep, SetupHealthStepState } from "../../../../src/view-model/setup-health";
import { fixAllLabel, remedyPlan } from "../../../../src/view-model/diagnostics";
import { Alert } from "../../ds/Alert";
import { Button } from "../../ds/Button";
import { Mark } from "../../ds/Mark";
import { StatusGlyph } from "../../ds/StatusGlyph";

const STEP_TITLES: Record<SetupHealthStep["id"], string> = {
  service: "Service ready",
  detect_agents: "Detect agents",
  integrations: "Integrations & hooks",
  usage_eligibility: "Usage & eligibility",
  notifications: "Turn on notifications",
  ready: "Ready to take work",
};

function glyph(state: SetupHealthStepState): { label: string; glyph: string; tone: "good" | "warn" | "bad" | "neutral" | "info" } {
  if (state === "passed") return { label: "Passed", glyph: "✓", tone: "good" };
  if (state === "failed") return { label: "Failed", glyph: "!", tone: "bad" };
  if (state === "needs_attention" || state === "timed_out") return { label: "Needs attention", glyph: "!", tone: "warn" };
  if (state === "running") return { label: "Checking", glyph: "…", tone: "info" };
  if (state === "not_checked") return { label: "Not checked", glyph: "·", tone: "neutral" };
  return { label: "Waiting", glyph: "·", tone: "neutral" };
}

/** Placeholder report while setup.health is in flight. */
export function pendingSetupHealthReport(trigger: SetupHealthReport["trigger"] = "startup"): SetupHealthReport {
  const steps: SetupHealthStep[] = (Object.keys(STEP_TITLES) as SetupHealthStep["id"][]).map((id, index) => ({
    id,
    title: STEP_TITLES[id],
    state: id === "service" ? "passed" : index === 1 ? "running" : "waiting",
  }));
  return {
    trigger,
    ...(trigger === "update" ? { eyebrow: "After update · checking setup" } : {}),
    title: "Checking setup",
    support: "Making sure agents can work through pacer.",
    steps,
    outcome: "ok",
    attentionCount: 0,
    checkedAt: 0,
  };
}

export function SetupHealthChip({
  outcome,
  attentionCount,
  onOpen,
}: {
  outcome: SetupHealthReport["outcome"];
  attentionCount: number;
  onOpen?: () => void;
}) {
  if (outcome === "ok") {
    return <aside className="pc-notice pc-setup-health-chip" aria-label="Setup status" role="status">
      <span>Setup OK · checked just now</span>
    </aside>;
  }
  if (attentionCount <= 0) return null;
  const label = `${attentionCount} fix${attentionCount === 1 ? "" : "es"} recommended`;
  return <aside className="pc-notice pc-setup-health-chip pc-setup-health-chip--attention" aria-label="Setup needs attention" role="status">
    <span>Setup · {label}</span>
    {onOpen
      ? <Button size="sm" onClick={onOpen}>Review</Button>
      : <a className="pc-text-action" href="#/settings/diagnostics">Open Diagnostics</a>}
  </aside>;
}

export function SetupHealthStage({
  report,
  busy = false,
  onContinue,
  onOpenDiagnostics,
  onRepair,
  onFixAll,
  onRerun,
  onRestartService,
  repairing = false,
  repairError,
  repairProgress,
  onSkip,
}: {
  report: SetupHealthReport;
  busy?: boolean;
  onContinue: () => void;
  onOpenDiagnostics: () => void;
  onRepair?: (repair: SetupHealthRepair) => void;
  onFixAll?: (repairs: SetupHealthRepair[]) => void;
  onRerun?: () => void;
  onRestartService?: () => void;
  repairing?: boolean;
  /** Why the last fix did not finish; the checks are unchanged. */
  repairError?: string;
  /** Progress line shown while a batch fix runs. */
  repairProgress?: string;
  /** Optional steps (notifications) offer Skip: remembered per install, never a hard fail. */
  onSkip?: () => void;
}) {
  const repairs = report.repairs ?? [];
  const primary = repairs.find(r => r.kind !== "open.diagnostics");
  const autoRepairs = repairs.filter(r => r.kind === "remedy" && r.remedy?.kind === "auto" && remedyPlan(r.remedy)?.kind === "run");
  const showFixAll = autoRepairs.length >= 2 && !!onFixAll;
  const nonAutoRepairs = repairs.filter(r => !(r.kind === "remedy" && r.remedy?.kind === "auto" && remedyPlan(r.remedy)?.kind === "run") && r.kind !== "open.diagnostics");
  const showRerun = !busy && !repairing && report.checkedAt > 0 && (repairs.length === 0 || repairs.every(r => r.kind === "open.diagnostics")) && !!onRerun;
  const hardFail = report.outcome === "hard_fail";
  const done = !busy && report.checkedAt > 0;
  // Skip is offered only while the notifications step needs attention and has not
  // been skipped yet (a skipped step reads 'Skipped' and shows no button).
  const notificationsStep = report.steps.find(s => s.id === "notifications");
  const skippable = done && notificationsStep?.state === "needs_attention" && (report.repairs?.some(r => r.skip) ?? false);
  const live = report.steps.map(s => `${s.title}: ${glyph(s.state).label}`).join(". ");
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!busy && done) main.current?.focus({ preventScroll: true });
  }, [busy, done, report.outcome]);

  return <main ref={main} className="pc-setup-health" aria-busy={busy || undefined} tabIndex={-1}>
    <div className="pc-setup-health__brand"><Mark size={28} /></div>
    {report.eyebrow && <p className="pc-setup-eyebrow">{report.eyebrow}</p>}
    <h1>{report.title}</h1>
    <p className="pc-setup-health__support">{report.support}</p>
    <ol className="pc-setup-health__steps" aria-label="Setup checks">
      {report.steps.map(step => {
        const status = glyph(step.state);
        return <li key={step.id} data-state={step.state}>
          <StatusGlyph status={status} />
          <div>
            <strong>{step.title}</strong>
            <span className="sr-only"> {status.label}</span>
            {step.detail && <p className="muted">{step.detail}</p>}
          </div>
        </li>;
      })}
    </ol>
    <p className="sr-only" role="status" aria-live="polite">{busy ? "Checking setup…" : live}</p>
    {done && hardFail && <Alert tone="error" title="Setup needs a fix before pacer can take work reliably">
      Review the failed steps, repair when available, or continue anyway and open Diagnostics.
    </Alert>}
    {done && report.outcome === "warnings" && <Alert tone="warning" title="Setup finished with recommended fixes" announce={false}>
      You can continue into pacer and fix these when you are ready.
    </Alert>}
    {done && report.outcome === "ok" && <Alert tone="success" title="Setup looks ready" announce={false} />}
    {done && repairError && <Alert tone="error" title="The fix did not finish">{repairError}</Alert>}
    {repairProgress && <p role="status" aria-live="polite" className="pc-setup-health__progress">{repairProgress}</p>}
    {done && <div className="pc-setup-health__actions">
      {showFixAll && <Button variant="primary" busy={repairing} disabled={busy || repairing} onClick={() => onFixAll!(autoRepairs)}>{fixAllLabel(autoRepairs.length)}</Button>}
      {showFixAll && nonAutoRepairs[0] && onRepair && <Button key={nonAutoRepairs[0].check ?? `${nonAutoRepairs[0].kind}:${nonAutoRepairs[0].label}`} busy={repairing} disabled={busy || repairing} onClick={() => onRepair(nonAutoRepairs[0])}>{nonAutoRepairs[0].label}</Button>}
      {!showFixAll && primary && onRepair && <Button variant="primary" busy={repairing} disabled={busy || repairing} onClick={() => onRepair(primary)}>{primary.label}</Button>}
      {showRerun && <Button variant="primary" disabled={busy || repairing} onClick={onRerun}>Run checks again</Button>}
      {showRerun && onRestartService && <Button disabled={busy || repairing} onClick={onRestartService}>Restart service</Button>}
      {hardFail && <Button variant={primary || showFixAll || showRerun ? undefined : "primary"} disabled={busy || repairing} onClick={onContinue}>Continue anyway</Button>}
      {!hardFail && <Button variant={primary || showFixAll || showRerun ? undefined : "primary"} disabled={busy || repairing} onClick={onContinue}>
        {report.outcome === "ok" ? "Continue" : "Continue to pacer"}
      </Button>}
      <Button variant="ghost" disabled={busy || repairing} onClick={onOpenDiagnostics}>Open Diagnostics</Button>
      {skippable && onSkip && <Button variant="ghost" disabled={busy || repairing} onClick={onSkip}>Skip notifications</Button>}
    </div>}
  </main>;
}
