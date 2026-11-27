import { useTaskContext } from './task-shared';
import { useEffect, useRef, useState } from "preact/hooks";
import type { Action } from "../../../src/api/read-model/types";
import type { ActionRunner } from "../data/actions";
import type { StoreState } from "../data/store";
import { useDialogs } from "../ds/useDialogs";
import { Button } from "../ds/Button";
import { afterVerdict } from "../data/announce";

/** One button for one service action, with its own pending, error and already-handled state. */
export function ActionButton({ runner, id, action, confirmDone, strong = false, "aria-label": ariaLabel }: { runner: ActionRunner; id: string; action: Action; confirmDone?: (s: StoreState) => boolean; strong?: boolean; "aria-label"?: string }) {
  useTaskContext();
  const unavailable = runner.unavailable(action);
  const dialogs = useDialogs();
  const [state, setState] = useState(runner.state(id));
  useEffect(() => runner.subscribe(() => setState(runner.state(id))), [runner, id]);
  // A busy button is disabled and loses focus: it takes it back once the call ends.
  const button = useRef<HTMLButtonElement>(null), pressed = useRef(false);
  useEffect(() => {
    if (state.status === "pending" || !pressed.current) return;
    pressed.current = false;
    const active = button.current?.ownerDocument.activeElement;
    if (!active || active === button.current?.ownerDocument.body) button.current?.focus();
  }, [state.status]);
  const click = async () => {
    const ask = runner.needsConfirm(action);
    if (ask && !await dialogs.confirm(ask, action.label, action.label)) return;
    pressed.current = true;
    void runner.run(id, action, confirmDone).then(outcome => { if (outcome.status === "done") afterVerdict(action); });
  };
  return <span className="pc-action">
    <Button ref={button} disabled={!!unavailable} title={unavailable} aria-label={ariaLabel} size="sm" variant={action.style === "danger" ? "danger" : strong ? "primary" : "secondary"} busy={state.status === "pending"} onClick={click}>{state.status === "pending" ? `${action.label}…` : action.label}</Button>
    {unavailable && <span className="muted">{unavailable}</span>}
    {dialogs.dialog}
    {state.status === "error" && <span className="op-error" role="status">{state.message}{state.hint ? ` · ${state.hint}` : ""}</span>}
    {state.status === "handled" && <span className="muted" role="status">{state.message}</span>}
  </span>;
}
