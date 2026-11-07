import { useEffect, useRef, useState } from "preact/hooks";
import { remedyPlan } from "../../../../src/view-model/diagnostics";
import type { SetupHealthRepair, SetupHealthReport } from "../../../../src/view-model/setup-health";
import type { BrowserApi } from "../../data/api";
import { dispatchRemedy, openRemedyUrl, recheckOnReturn, type RemedyHost } from "../../data/remedies";
import { platform } from "../../platform";
import { useDialogs } from "../../ds/useDialogs";
import { pendingSetupHealthReport, SetupHealthStage } from "./SetupHealth";

type GatePhase = "idle" | "checking" | "stage" | "ready";

export type SetupHealthSummary = Pick<SetupHealthReport, "outcome" | "attentionCount" | "checkedAt" | "trigger" | "repairs">;

function summaryOf(report: SetupHealthReport): SetupHealthSummary {
  return {
    outcome: report.outcome,
    attentionCount: report.attentionCount,
    checkedAt: report.checkedAt,
    trigger: report.trigger,
    repairs: report.repairs,
  };
}

/** Honest hard-fail report when setup.health cannot run; used by the gate (never silent skip). */
export function setupHealthFailureReport(trigger: SetupHealthReport["trigger"] = "startup"): SetupHealthReport {
  const pending = pendingSetupHealthReport(trigger);
  return {
    ...pending,
    checkedAt: Date.now() / 1000,
    outcome: "hard_fail",
    attentionCount: 1,
    steps: pending.steps.map(step => ({
      ...step,
      state: step.id === "service" ? "failed" : "needs_attention",
      detail: step.id === "service" ? "Setup checks could not finish. Open Diagnostics or continue anyway." : undefined,
    })),
    repairs: [{ kind: "open.diagnostics", label: "Open Diagnostics" }],
  };
}

export type SetupHealthLoadResult =
  | { kind: "skip"; summary: SetupHealthSummary }
  | { kind: "stage"; report: SetupHealthReport; autoEnterMs?: number }
  | { kind: "fail"; report: SetupHealthReport };

/** Pure load path for the gate: skip, show stage, or hard-fail — never silent ready. */
export async function loadSetupHealthGate(
  call: BrowserApi["call"],
): Promise<SetupHealthLoadResult> {
  try {
    const next = await call<SetupHealthReport & { skipFullWindow?: boolean }>("setup.health", { trigger: "startup" });
    if (next.skipFullWindow) return { kind: "skip", summary: summaryOf(next) };
    if (next.outcome === "hard_fail") return { kind: "stage", report: next };
    return { kind: "stage", report: next, autoEnterMs: next.outcome === "ok" ? 600 : 1200 };
  } catch {
    return { kind: "fail", report: setupHealthFailureReport("startup") };
  }
}

/** Map a load result to the gate commit — fail and stage never auto-enter ready. */
export function commitSetupHealthLoad(
  result: SetupHealthLoadResult,
):
  | { action: "ready"; summary: SetupHealthSummary }
  | { action: "stage"; report: SetupHealthReport; autoEnterMs?: number } {
  if (result.kind === "skip") return { action: "ready", summary: result.summary };
  if (result.kind === "fail") return { action: "stage", report: result.report };
  return { action: "stage", report: result.report, autoEnterMs: result.autoEnterMs };
}

type Confirm = (message: string, title?: string, confirmLabel?: string) => Promise<boolean>;
const fileList = (files: string[]) => files.length ? `\n\n${files.join("\n")}` : "";

/** The gate's side of the shared remedy dispatch: confirmations are dialogs, agent tasks open their task page. */
export function gateRemedyHost(api: Pick<BrowserApi, "call">, confirm: Confirm, open: (url: string) => void = url => openRemedyUrl(url, platform)): RemedyHost {
  return {
    call: (op, params) => api.call(op, params),
    confirm: request => confirm(`${request.message}${fileList(request.files)}`, request.title, request.confirmLabel),
    review: preview => confirm(
      `${preview.detail ?? "Reconnect this integration."}${fileList(preview.files ?? [])}\n\nReview the files that will change before applying.`,
      "Review repair",
      "Apply repair",
    ),
    delegate: async check => {
      if (!await confirm("Pacer has no built-in fix for this, so it starts a task with everything the check found. You review the result like any other task.", "Fix with agent", "Start fix task")) return false;
      const result = await api.call<{ task: { task_id: string } }>("doctor.fix.delegate", { check, scope: "fix" });
      location.hash = `#/tasks/${encodeURIComponent(result.task.task_id)}`;
      return true;
    },
    open,
  };
}

export async function applyRepair(repair: SetupHealthRepair, host: RemedyHost): Promise<"rerun" | "rerun-on-return" | "navigate" | "done"> {
  const plan = repair.kind === "remedy" && repair.remedy ? remedyPlan(repair.remedy) : undefined;
  if (!plan) {
    location.hash = "#/settings/diagnostics";
    return "navigate";
  }
  const result = await dispatchRemedy(plan, host);
  if (result === "recheck") return "rerun";
  if (result === "await-return") return "rerun-on-return";
  return result === "delegated" ? "navigate" : "done";
}

/** Full-window Checking setup after service connect; skip when fingerprint is fresh. */
export function SetupHealthGate({
  api,
  connected,
  enabled,
  onReady,
}: {
  api: BrowserApi;
  connected: boolean;
  enabled: boolean;
  onReady: (summary: SetupHealthSummary | null) => void;
}) {
  const dialogs = useDialogs();
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const [phase, setPhase] = useState<GatePhase>("idle");
  const [report, setReport] = useState<SetupHealthReport | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [autoEnterMs, setAutoEnterMs] = useState<number>();
  const enterTimer = useRef<number>();
  const [repairError, setRepairError] = useState<string>();
  const returnRecheck = useRef<() => void>();
  useEffect(() => () => returnRecheck.current?.(), []);

  useEffect(() => {
    if (!enabled || !connected || phase !== "idle") return;
    setPhase("checking");
    setReport(pendingSetupHealthReport("startup"));
  }, [enabled, connected, phase]);

  useEffect(() => {
    if (phase !== "checking" || !connected || !enabled) return;
    let active = true;
    void loadSetupHealthGate(api.call).then(result => {
      if (!active) return;
      const commit = commitSetupHealthLoad(result);
      if (commit.action === "ready") {
        setPhase("ready");
        onReadyRef.current(commit.summary);
        return;
      }
      setReport(commit.report);
      setAutoEnterMs(commit.autoEnterMs);
      setPhase("stage");
    });
    return () => { active = false; };
  }, [api, connected, enabled, phase]);

  // Separate from the load effect: leaving "checking" runs that effect's cleanup.
  useEffect(() => {
    if (phase !== "stage" || autoEnterMs == null || !report) return;
    const timer = window.setTimeout(() => {
      setPhase("ready");
      onReadyRef.current(summaryOf(report));
    }, autoEnterMs);
    enterTimer.current = timer;
    return () => window.clearTimeout(timer);
  }, [phase, autoEnterMs, report]);

  if (!enabled || phase === "idle" || phase === "ready") return null;
  const view = report ?? pendingSetupHealthReport("startup");

  const finish = (next: SetupHealthSummary | null, hash?: string) => {
    if (enterTimer.current) window.clearTimeout(enterTimer.current);
    setPhase("ready");
    onReadyRef.current(next);
    if (hash) location.hash = hash;
  };

  return <>
    <SetupHealthStage
      report={view}
      busy={phase === "checking" || !view.checkedAt}
      repairing={repairing}
      repairError={repairError}
      onContinue={() => finish(view.checkedAt ? summaryOf(view) : null)}
      onOpenDiagnostics={() => finish(view.checkedAt ? summaryOf(view) : null, "#/settings/diagnostics")}
      onRepair={async repair => {
        if (enterTimer.current) window.clearTimeout(enterTimer.current);
        setRepairing(true);
        setRepairError(undefined);
        returnRecheck.current?.();
        try {
          const result = await applyRepair(repair, gateRemedyHost(api, dialogs.confirm));
          if (result === "navigate") {
            finish(view.checkedAt ? summaryOf(view) : null);
            return;
          }
          const rerun = () => {
            setReport(pendingSetupHealthReport(view.trigger));
            setPhase("checking");
          };
          if (result === "rerun") rerun();
          if (result === "rerun-on-return") returnRecheck.current = recheckOnReturn(rerun);
        } catch (failure) {
          setRepairError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setRepairing(false);
        }
      }}
    />
    {dialogs.dialog}
  </>;
}
