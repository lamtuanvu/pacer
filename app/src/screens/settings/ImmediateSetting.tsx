import type { ComponentChildren } from "preact";
import { ImmediateSave } from "../../ds/ImmediateSave";
import { useTaskContext } from "../task-shared";

/** Settings bind service operations; the shared DS boundary owns feedback and rollback. */
export function ImmediateSetting<T>({ value, operation, onSaved, children }: {
  value: T; operation: (value: T) => { op: string; params: unknown }; onSaved?: () => void;
  children: (value: T, change: (value: T) => void, busy: boolean) => ComponentChildren;
}) {
  const { api } = useTaskContext();
  return <ImmediateSave value={value} save={async next => { const request = operation(next); await api.call(request.op, request.params); onSaved?.(); }}>{children}</ImmediateSave>;
}
