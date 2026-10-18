import { useEffect, useState } from "preact/hooks";
import type { Action } from "../../../src/api/read-model/types";
import type { ActionRunner } from "../data/actions";
import type { StoreState } from "../data/store";
import { Button } from "../ds/Button";

/** One button for one service action, with its own pending, error and already-handled state. */
export function ActionButton({ runner, id, action, confirmDone, strong = false }: { runner: ActionRunner; id: string; action: Action; confirmDone?: (s: StoreState) => boolean; strong?: boolean }) {
  const [state, setState] = useState(runner.state(id));
  useEffect(() => runner.subscribe(() => setState(runner.state(id))), [runner, id]);
  const click = () => {
    const ask = runner.needsConfirm(action);
    if (ask && !window.confirm(ask)) return;
    void runner.run(id, action, confirmDone);
  };
  const tone = strong ? "pc-btn--strong" : action.style === "danger" ? "pc-btn--danger" : "";
  return <span className="pc-action">
    <Button size="sm" variant={strong ? "primary" : "secondary"} className={tone} disabled={state.status === "pending"} onClick={click}>{state.status === "pending" ? `${action.label}…` : action.label}</Button>
    {state.status === "error" && <span className="op-error" role="status">{state.message}{state.hint ? ` · ${state.hint}` : ""}</span>}
    {state.status === "handled" && <span className="muted" role="status">{state.message}</span>}
  </span>;
}
