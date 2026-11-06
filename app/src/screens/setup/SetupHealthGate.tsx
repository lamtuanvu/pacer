import { useEffect, useRef, useState } from "preact/hooks";
import type { SetupHealthRepair, SetupHealthReport } from "../../../../src/view-model/setup-health";
import type { BrowserApi } from "../../data/api";
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

async function applyRepair(
  api: BrowserApi,
  repair: SetupHealthRepair,
  confirm: (message: string, title?: string, confirmLabel?: string) => Promise<boolean>,
): Promise<"rerun" | "navigate" | "done"> {
  if (repair.kind === "limits.refresh") {
    await api.call("limits.refresh", {});
    return "rerun";
  }
  if (repair.kind === "agent.reconnect" && repair.agent) {
    const preview = await api.call<{ agent: string; revision: string; files: string[]; detail?: string }>("agent.preview", { agent: repair.agent });
    const files = preview.files?.length ? `\n\n${preview.files.join("\n")}` : "";
    const ok = await confirm(
      `${preview.detail ?? "Reconnect this planner integration."}${files}\n\nReview the files that will change before applying.`,
      "Review repair",
      "Apply repair",
    );
    if (!ok) return "done";
    await api.call("agent.connect", { agent: preview.agent, consent: true, preview_revision: preview.revision });
    return "rerun";
  }
  if (repair.kind === "open.setup") {
    location.hash = "#/setup";
    return "navigate";
  }
  if (repair.kind === "open.accounts") {
    location.hash = "#/settings/accounts";
    return "navigate";
  }
  if (repair.kind === "open.add_executor") {
    location.hash = "#/settings/add-executor";
    return "navigate";
  }
  location.hash = "#/settings/diagnostics";
  return "navigate";
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
  const enterTimer = useRef<number>();

  useEffect(() => {
    if (!enabled || !connected || phase !== "idle") return;
    setPhase("checking");
    setReport(pendingSetupHealthReport("startup"));
  }, [enabled, connected, phase]);

  useEffect(() => {
    if (phase !== "checking" || !connected || !enabled) return;
    let active = true;
    void api.call<SetupHealthReport & { skipFullWindow?: boolean }>("setup.health", { trigger: "startup" }).then(
      next => {
        if (!active) return;
        setReport(next);
        if (next.skipFullWindow) {
          setPhase("ready");
          onReadyRef.current(summaryOf(next));
          return;
        }
        setPhase("stage");
      },
      () => {
        if (!active) return;
        setPhase("ready");
        onReadyRef.current(null);
      },
    );
    return () => { active = false; };
  }, [api, connected, enabled, phase]);

  useEffect(() => {
    if (phase !== "stage" || !report?.checkedAt || report.outcome === "hard_fail") return;
    let active = true;
    enterTimer.current = window.setTimeout(() => {
      if (!active) return;
      setPhase("ready");
      onReadyRef.current(summaryOf(report));
    }, report.outcome === "ok" ? 600 : 1200);
    return () => {
      active = false;
      if (enterTimer.current) window.clearTimeout(enterTimer.current);
    };
  }, [phase, report]);

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
      onContinue={() => finish(view.checkedAt ? summaryOf(view) : null)}
      onOpenDiagnostics={() => finish(view.checkedAt ? summaryOf(view) : null, "#/settings/diagnostics")}
      onRepair={async repair => {
        if (enterTimer.current) window.clearTimeout(enterTimer.current);
        setRepairing(true);
        try {
          const result = await applyRepair(api, repair, dialogs.confirm);
          if (result === "navigate") {
            finish(view.checkedAt ? summaryOf(view) : null);
            return;
          }
          if (result === "rerun") {
            setReport(pendingSetupHealthReport(view.trigger));
            setPhase("checking");
          }
        } finally {
          setRepairing(false);
        }
      }}
    />
    {dialogs.dialog}
  </>;
}
