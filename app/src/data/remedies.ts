import { remedyConsent, type RemedyConsent, type RemedyPlan } from "../../../src/view-model/diagnostics";
import type { Platform } from "../platform/types";

export interface PreviewFile { path: string; change: "create" | "update" | "restore" | "unchanged" | "kept"; note: string }
export interface UndoSnapshot { revision: string; at: number; files: { path: string; change: "restore" | "remove" }[] }
export interface RepairPreview { revision: string; agent: string; files: string[]; changes?: PreviewFile[]; undo?: string; detail?: string; undoSnapshot?: UndoSnapshot }
export interface ConsentRequest extends RemedyConsent { files: string[] }
type RunPlan = Extract<RemedyPlan, { kind: "run" }>;
/** An operation ready to call, with the confirmation it needs first. */
export interface PreparedRun { op: string; params: Record<string, unknown>; consent?: ConsentRequest }
/** `recheck`: rerun the checks now. `await-return`: rerun when the person comes back to the window. */
export type RemedyResult = "recheck" | "await-return" | "cancelled" | "delegated";

/** The screen-specific parts of a remedy: how to ask, how to show a review, where an agent task starts. */
export interface RemedyHost {
  call: <T>(op: string, params: unknown) => Promise<T>;
  /** Resolves true only after the person's click. */
  confirm: (request: ConsentRequest) => Promise<boolean>;
  review: (preview: RepairPreview) => Promise<boolean>;
  delegate: (check: string) => Promise<boolean>;
  open: (url: string) => void;
}

/** File updates name the files from a fresh preview, and apply only that preview's revision. */
export async function prepareRun(plan: RunPlan, call: RemedyHost["call"]): Promise<PreparedRun> {
  if (!plan.consent) return { op: plan.op, params: plan.params };
  if (plan.op === "agent.connect" && typeof plan.params.agent === "string") {
    const preview = await call<RepairPreview>("agent.preview", { agent: plan.params.agent });
    const files = preview.files ?? [];
    return { op: plan.op, params: { ...plan.params, agent: preview.agent, preview_revision: preview.revision },
      consent: { ...remedyConsent({ kind: "auto", label: plan.consent.confirmLabel, op: plan.op, params: plan.params }, files), files } };
  }
  return { op: plan.op, params: plan.params, consent: { ...plan.consent, files: [] } };
}

/** Consent is added here, after the caller has confirmed; the remedy never carries it. */
export function commitRun(run: PreparedRun, call: RemedyHost["call"]): Promise<unknown> {
  return call(run.op, run.consent ? { ...run.params, consent: true } : run.params);
}

export async function dispatchRemedy(plan: RemedyPlan, host: RemedyHost): Promise<RemedyResult> {
  switch (plan.kind) {
    case "run": {
      const run = await prepareRun(plan, host.call);
      if (run.consent && !await host.confirm(run.consent)) return "cancelled";
      await commitRun(run, host.call);
      return "recheck";
    }
    case "review": {
      const preview = await host.call<RepairPreview>("agent.preview", { agent: plan.agent });
      if (!await host.review(preview)) return "cancelled";
      await host.call("agent.connect", { agent: preview.agent, consent: true, preview_revision: preview.revision });
      return "recheck";
    }
    case "signin":
      if (plan.consent && !await host.confirm({ ...plan.consent, files: [] })) return "cancelled";
      await host.call(plan.op, plan.consent ? { ...plan.params, consent: true } : plan.params);
      return "await-return";
    case "open":
      host.open(plan.url);
      return "await-return";
    case "delegate":
      return await host.delegate(plan.check) ? "delegated" : "cancelled";
  }
}

/** Calls `recheck` once, the next time the window regains focus. Returns a cancel function. */
export function recheckOnReturn(recheck: () => void, target: Pick<Window, "addEventListener" | "removeEventListener"> = window): () => void {
  const listener = () => { target.removeEventListener("focus", listener); recheck(); };
  target.addEventListener("focus", listener);
  return () => target.removeEventListener("focus", listener);
}

/** The desktop shell opens only https links from service pages, so a System Settings pane must be opened by hand there. */
export function openRemedyUrl(url: string, target: Pick<Platform, "desktop" | "openExternal">): void {
  if (target.desktop && !url.startsWith("https://"))
    throw new Error("The desktop app can only open web links. Open System Settings › Privacy & Security yourself, then run the checks again.");
  target.openExternal(url);
}
