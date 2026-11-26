import type { AttentionItem } from "../../../../src/attention/types";
import { isConflictGate } from "../../../../src/view-model/run-gate";
import { Alert } from "../../ds/Alert";
import { Disclosure } from "../../ds/Controls";
import { useActions } from "../../data/action-context";
import { ActionButton } from "../ActionButton";

/** The commands that resolve a conflict by hand, whole and selectable, and any raw detail kept collapsed. */
export function GateSteps({ item }: { item: AttentionItem }) {
  return <>
    {!!item.gate?.commands?.length && <pre className="pc-code-scroll" tabIndex={0} aria-label="Commands that resolve the conflict">{item.gate.commands.join("\n")}</pre>}
    {item.gate?.technical && <Disclosure summary="Technical details"><code className="pc-code-wrap">{item.gate.technical}</code></Disclosure>}
  </>;
}

/** What a workflow review gate holds up on a task page, with the actions `offer` selects from its item. */
export function RunGatePanel({ item, offer = () => true }: { item: AttentionItem; offer?: (op: string, verdict: unknown) => boolean }) {
  const runner = useActions();
  const actions = item.actions.filter(action => offer(action.op, action.params.verdict));
  return <section className="pc-action-panel" aria-label={item.title}>
    <Alert tone={isConflictGate(item) ? "warning" : "info"} title={item.title} announce={false}><p>{item.detail}</p></Alert>
    <GateSteps item={item} />
    {!!actions.length && <div className="row-actions">{actions.map((action, i) => <ActionButton key={action.label} runner={runner} id={`gate:${item.id}:${i}`} action={action} strong={action.style === "primary"} />)}</div>}
  </section>;
}
/** On a step's own page the verdict buttons exist already: the panel adds only the send-back. */
export const sendBackOnly = (op: string, verdict: unknown): boolean => op === "task.review" && verdict === "send_back";
