/** Setup: the shared checklist as rows. Enter runs the selected step after consent. */
import type { SetupChecklist, SetupItem } from "../../setup/checklist";
import type { Status } from "../../view-model/words";
import { cols, flex, heading, span, statusSpans } from "../frame";
import type { Act, Item } from "../state";
import { blank, GAP, MARK } from "./common";
import type { Row, ScreenCtx, ScreenView } from "./types";

const STATUS: Record<SetupItem["status"], Status> = {
  done: { label: "Done", tone: "good", glyph: "✓" },
  failed: { label: "Failed", tone: "bad", glyph: "✕" },
  pending: { label: "Needs you", tone: "warn", glyph: "!" },
};

/** The act for a setup step, or undefined when the step has nothing to run here. Ops absent from hello.ops are hidden (UI-13). */
export function setupAct(checklist: Pick<SetupChecklist, "items">, item: SetupItem, supports: (op: string) => boolean): Act | undefined {
  if (item.status === "done") return undefined;
  const executorReady = checklist.items.some(i => i.id === "executor" && i.status === "done");
  if (item.id === "executor" || item.action === "nav:add-executor") return { label: "Add executor", effect: { type: "handoff", argv: ["runner", "add"], label: "Add executor" } };
  if (item.action === "service.install" && supports("service.install")) {
    return { label: "Install service", effect: { type: "action", action: { label: "Install service", op: "service.install", params: { consent: true } } },
      confirm: { title: "Run pacer in the background at login?", body: ["It keeps budgets fresh and runs delegated tasks."], yes: "Install service" } };
  }
  if (item.action === "agent.connect" && item.agent && supports("agent.connect") && supports("agent.preview")) {
    return { label: `Connect ${item.agent}`, effect: { type: "flow", name: "connect-agent", params: { agent: item.agent } } };
  }
  if (item.id === "first" && executorReady && supports("onboarding.try")) {
    return { label: "Try a delegation", effect: { type: "action", action: { label: "Try a delegation", op: "onboarding.try", params: {} } } };
  }
  if (item.command) return { label: "Show command", effect: { type: "local", label: item.command, run: () => {} } };
  return undefined;
}

export function setupScreen(ctx: ScreenCtx): ScreenView {
  const { theme } = ctx, setup = ctx.s.setup;
  const rows: Row[] = [], items: Item[] = [];
  if (!setup) return { list: [{ line: [span("Checking setup…", { fg: "muted" })] }], items };
  rows.push({ line: [span("pacer works once the required steps are done. The rest makes it useful.", { fg: "secondary" })] });
  if (setup.complete) {
    const home: Act = { label: "Go to Home", effect: { type: "navigate", screen: "home" } };
    rows.push(blank(), { line: statusSpans(theme, { label: "Required setup done", tone: "good", glyph: "✓" }), item: "setup:done" });
    items.push({ id: "setup:done", primary: home, actions: [], keys: {} });
  }
  const width = ctx.width - MARK, w = flex(width, [{ fixed: 13 }, { weight: 2, min: 16 }, { weight: 3, min: 10 }]);
  const checklist = { items: setup.items };
  const firstOpen = setup.items.find(i => i.required && i.status !== "done");
  for (const [title, required] of [["Required", true], ["Recommended", false]] as const) {
    const group = setup.items.filter(i => i.required === required);
    if (!group.length) continue;
    rows.push(blank(), { line: heading(theme, title, `${group.filter(i => i.status === "done").length} of ${group.length}`, "done", false) });
    for (const item of group) {
      const act = setupAct(checklist, item, ctx.supports);
      const blocked = !item.required && firstOpen && item.id === "first" && !act;
      const skip: Act | undefined = item.id === "first" && item.status !== "done" && ctx.supports("onboarding.skip")
        ? { label: "Skip first delegation", effect: { type: "action", action: { label: "Skip first delegation", op: "onboarding.skip", params: {} } } } : undefined;
      items.push({ id: `setup:${item.id}`, primary: act, actions: skip ? [skip] : [], keys: skip ? { x: skip } : {} });
      const detail = item.command && item.status !== "done" ? `${item.detail ? `${item.detail} · ` : ""}${item.command}` : item.detail ?? (blocked ? "Finish the required steps first." : "");
      rows.push({ item: `setup:${item.id}`, line: cols([
        { content: statusSpans(theme, STATUS[item.status]), width: w[0]! },
        { content: item.title, width: w[1]!, style: { bold: item.id === firstOpen?.id } },
        { content: detail, width: w[2]!, style: { fg: "secondary" } },
      ], GAP, theme) });
    }
  }
  const next = setup.items.find(i => i.status !== "done" && setupAct(checklist, i, ctx.supports));
  return { list: rows, items, ...(next ? { initial: `setup:${next.id}` } : {}) };
}
