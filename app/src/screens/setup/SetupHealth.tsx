import type { SetupHealthRepair, SetupHealthReport, SetupHealthStep, SetupHealthStepState } from "../../../../src/view-model/setup-health";
import { Alert } from "../../ds/Alert";
import { Button } from "../../ds/Button";
import { Mark } from "../../ds/Mark";
import { StatusGlyph } from "../../ds/StatusGlyph";

const STEP_TITLES: Record<SetupHealthStep["id"], string> = {
  service: "Service ready",
  detect_agents: "Detect agents",
  integrations: "Integrations & hooks",
  usage_eligibility: "Usage & eligibility",
  ready: "Ready to take work",
};

function glyph(state: SetupHealthStepState): { label: string; glyph: string; tone: "good" | "warn" | "bad" | "neutral" | "info" } {
  if (state === "passed") return { label: "Passed", glyph: "✓", tone: "good" };
  if (state === "failed") return { label: "Failed", glyph: "!", tone: "bad" };
  if (state === "needs_attention" || state === "timed_out") return { label: "Needs attention", glyph: "!", tone: "warn" };
  if (state === "running") return { label: "Checking", glyph: "…", tone: "info" };
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
  return <aside className="pc-notice pc-setup-health-chip pc-setup-health-chip--attention" aria-label="Setup needs attention">
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
  repairing = false,
}: {
  report: SetupHealthReport;
  busy?: boolean;
  onContinue: () => void;
  onOpenDiagnostics: () => void;
  onRepair?: (repair: SetupHealthRepair) => void;
  repairing?: boolean;
}) {
  const primary = report.repairs?.[0];
  const hardFail = report.outcome === "hard_fail";
  const done = !busy && report.checkedAt > 0;
  const live = report.steps.map(s => `${s.title}: ${glyph(s.state).label}`).join(". ");

  return <main className="pc-setup-health" aria-busy={busy || undefined}>
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
    {done && <div className="pc-setup-health__actions">
      {primary && onRepair && <Button variant="primary" busy={repairing} disabled={busy || repairing} onClick={() => onRepair(primary)}>{primary.label}</Button>}
      {hardFail && <Button variant={primary ? undefined : "primary"} disabled={busy || repairing} onClick={onContinue}>Continue anyway</Button>}
      {!hardFail && <Button variant={primary ? undefined : "primary"} disabled={busy || repairing} onClick={onContinue}>
        {report.outcome === "ok" ? "Continue" : "Continue to pacer"}
      </Button>}
      <Button variant="ghost" disabled={busy || repairing} onClick={onOpenDiagnostics}>Open Diagnostics</Button>
    </div>}
  </main>;
}
