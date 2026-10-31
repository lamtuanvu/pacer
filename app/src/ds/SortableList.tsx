import type { ComponentChildren, JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons";
import { Button } from "./Button";
import { classNames } from "./classNames";

/** Move one entry to a new index; out-of-range targets leave the order unchanged. */
export function moveKey<T>(keys: readonly T[], from: number, to: number): T[] {
  const next = [...keys];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}
export const positionAnnouncement = (label: string, index: number, total: number) => `${label} moved to position ${index + 1} of ${total}.`;

/** Stable keys for a list whose entries have no identity of their own; callers splice them alongside the data. */
export function useStableKeys(count: number) {
  const keys = useRef<string[]>([]), next = useRef(0);
  while (keys.current.length < count) keys.current.push(`k${next.current++}`);
  if (keys.current.length > count) keys.current = keys.current.slice(0, count);
  return keys;
}
/** Runs a focus lookup after the next render, for controls that disappear or move when used. */
export function useFocusAfterRender() {
  const pending = useRef<(() => HTMLElement | null | undefined) | null>(null);
  useLayoutEffect(() => { const find = pending.current; if (!find) return; pending.current = null; find()?.focus(); });
  return (find: () => HTMLElement | null | undefined) => { pending.current = find; };
}

export interface SortableItem { key: string; label: string; detail?: ComponentChildren; leading?: ComponentChildren; trailing?: ComponentChildren; displayLabel?: ComponentChildren }
type Control = "up" | "down" | "remove";
interface Drag { key: string; from: number; over: number; pointer: number }

/**
 * Ordered list with a pointer drag handle. Move up, Move down and Remove buttons are the
 * keyboard path; focus stays on the moved item and a polite live region announces the result.
 */
export function SortableList({ label, items, onReorder, onRemove, disabled, renderExtra, iconControls = false, layout }: {
  iconControls?: boolean;
  layout?: "executor";
  label: string;
  items: readonly SortableItem[];
  onReorder: (keys: string[]) => void;
  onRemove?: (key: string) => void;
  disabled?: boolean;
  renderExtra?: (item: SortableItem, index: number) => ComponentChildren;
}) {
  const list = useRef<HTMLOListElement>(null);
  const focusAfter = useFocusAfterRender();
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const keys = items.map(item => item.key);

  const focusControl = (key: string, controls: Control[]) => focusAfter(() => {
    const row = [...(list.current?.children ?? [])].find(child => (child as HTMLElement).dataset.sortableKey === key);
    return controls.map(name => row?.querySelector<HTMLButtonElement>(`[data-sortable-control="${name}"]`)).find(Boolean) ?? list.current;
  });

  const move = (index: number, to: number, controls: Control[]) => {
    const item = items[index];
    if (!item || to < 0 || to >= items.length) return;
    focusControl(item.key, controls);
    setAnnouncement(positionAnnouncement(item.label, to, items.length));
    onReorder(moveKey(keys, index, to));
  };
  const remove = (index: number) => {
    const item = items[index]!, neighbour = items[index + 1] ?? items[index - 1];
    if (neighbour) focusControl(neighbour.key, ["remove", "down", "up"]); else focusAfter(() => list.current);
    setAnnouncement(`${item.label} removed.`);
    onRemove?.(item.key);
  };

  const finalIndex = (state: Drag, clientY: number) => {
    const rows = [...(list.current?.querySelectorAll(":scope > [data-sortable-key]") ?? [])] as HTMLElement[];
    return rows.filter((row, at) => at !== state.from && row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2 < clientY).length;
  };
  const startDrag = (event: JSX.TargetedPointerEvent<HTMLSpanElement>, index: number) => {
    if (disabled || event.button !== 0 || items.length < 2) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const state = { key: items[index]!.key, from: index, over: index, pointer: event.pointerId };
    dragRef.current = state;
    setDrag(state);
  };
  const moveDrag = (event: JSX.TargetedPointerEvent<HTMLSpanElement>) => {
    const state = dragRef.current;
    if (!state || state.pointer !== event.pointerId) return;
    const over = finalIndex(state, event.clientY);
    if (over !== state.over) setDrag(dragRef.current = { ...state, over });
  };
  const endDrag = (event: JSX.TargetedPointerEvent<HTMLSpanElement>, commit: boolean) => {
    const state = dragRef.current;
    if (!state || state.pointer !== event.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    const to = finalIndex(state, event.clientY);
    if (commit && to !== state.from) {
      setAnnouncement(positionAnnouncement(items[state.from]!.label, to, items.length));
      onReorder(moveKey(keys, state.from, to));
    }
  };

  return <div className={classNames("pc-sortable", iconControls && "pc-sortable--icons", layout && `pc-sortable--${layout}`)}>
    <ol ref={list} className="pc-sortable__list" aria-label={label} tabIndex={-1}>
      {items.map((item, index) => <li key={item.key} data-sortable-key={item.key}
        className={classNames("pc-sortable__item", drag?.key === item.key && "pc-sortable__item--dragging",
          drag && drag.over !== drag.from && drag.over === index && "pc-sortable__item--drop-target")}>
        <div className="pc-sortable__row">
          {items.length > 1 && <span className="pc-sortable__handle" aria-hidden="true" title="Drag to reorder"
            onPointerDown={event => startDrag(event, index)} onPointerMove={moveDrag}
            onPointerUp={event => endDrag(event, true)} onPointerCancel={event => endDrag(event, false)}>
            <svg viewBox="0 0 10 16" focusable="false"><path d="M2 2h2v2H2zm4 0h2v2H6zM2 7h2v2H2zm4 0h2v2H6zM2 12h2v2H2zm4 0h2v2H6z" /></svg>
          </span>}
          {item.leading}<div className="pc-sortable__content"><strong className="pc-sortable__label" title={item.label}>{item.displayLabel ?? item.label}</strong>{item.detail}</div>
          {item.trailing}<div className="pc-sortable__actions">
            {index > 0 && <Button size="sm" variant={iconControls ? "quiet" : "secondary"} data-sortable-control="up" aria-label={`Move up: ${item.label}`} disabled={disabled}
              onClick={() => move(index, index - 1, ["up", "down"])}>{iconControls ? <Icon name="chevron-up"/> : "Move up"}</Button>}
            {index < items.length - 1 && <Button size="sm" variant={iconControls ? "quiet" : "secondary"} data-sortable-control="down" aria-label={`Move down: ${item.label}`} disabled={disabled}
              onClick={() => move(index, index + 1, ["down", "up"])}>{iconControls ? <Icon name="chevron-down"/> : "Move down"}</Button>}
            {onRemove && <Button size="sm" variant="quiet" data-sortable-control="remove" aria-label={`Remove: ${item.label}`} disabled={disabled}
              onClick={() => remove(index)}>{iconControls ? <Icon name="close"/> : "Remove"}</Button>}
          </div>
        </div>
        {renderExtra?.(item, index)}
      </li>)}
      {layout === "executor" && <li className="pc-sortable__drop-guide" aria-hidden="true">Drag an executor here to move it to the end</li>}
    </ol>
    {layout === "executor" && <p className="pc-sortable__help">Drag to reorder, or use the Move up and Move down buttons with the keyboard. Use + to add an available executor.</p>}
    <p className="pc-sortable__status" role="status" aria-live="polite">{announcement}</p>
  </div>;
}
