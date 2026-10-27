import type { ComponentChildren, JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
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

export interface SortableItem { key: string; label: string; detail?: ComponentChildren }
type Control = "up" | "down" | "remove";
interface Drag { key: string; from: number; over: number; pointer: number }

/**
 * Ordered list with a pointer drag handle. Move up, Move down and Remove buttons are the
 * keyboard path; focus stays on the moved item and a polite live region announces the result.
 */
export function SortableList({ label, items, onReorder, onRemove, disabled, renderExtra }: {
  label: string;
  items: readonly SortableItem[];
  onReorder: (keys: string[]) => void;
  onRemove?: (key: string) => void;
  disabled?: boolean;
  renderExtra?: (item: SortableItem, index: number) => ComponentChildren;
}) {
  const list = useRef<HTMLOListElement>(null);
  const pending = useRef<{ key: string; controls: Control[] } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const keys = items.map(item => item.key);

  useLayoutEffect(() => {
    const target = pending.current;
    if (!target || !list.current) return;
    pending.current = null;
    const row = [...list.current.children].find(child => (child as HTMLElement).dataset.sortableKey === target.key);
    const control = target.controls.map(name => row?.querySelector<HTMLButtonElement>(`[data-sortable-control="${name}"]`)).find(Boolean);
    (control ?? list.current).focus();
  });

  const move = (index: number, to: number, controls: Control[]) => {
    const item = items[index];
    if (!item || to < 0 || to >= items.length) return;
    pending.current = { key: item.key, controls };
    setAnnouncement(positionAnnouncement(item.label, to, items.length));
    onReorder(moveKey(keys, index, to));
  };
  const remove = (index: number) => {
    const item = items[index]!, neighbour = items[index + 1] ?? items[index - 1];
    pending.current = neighbour ? { key: neighbour.key, controls: ["remove", "down", "up"] } : null;
    setAnnouncement(`${item.label} removed.`);
    onRemove?.(item.key);
    if (!neighbour) requestAnimationFrame(() => list.current?.focus());
  };

  const finalIndex = (state: Drag, clientY: number) => {
    const rows = [...(list.current?.children ?? [])] as HTMLElement[];
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

  return <div className="pc-sortable">
    <ol ref={list} className="pc-sortable__list" aria-label={label} tabIndex={-1}>
      {items.map((item, index) => <li key={item.key} data-sortable-key={item.key}
        className={classNames("pc-sortable__item", drag?.key === item.key && "pc-sortable__item--dragging",
          drag && drag.over !== drag.from && drag.over === index && "pc-sortable__item--drop-target")}>
        <div className="pc-sortable__row">
          {items.length > 1 && <span className="pc-sortable__handle" aria-hidden="true" title="Drag to reorder"
            onPointerDown={event => startDrag(event, index)} onPointerMove={moveDrag}
            onPointerUp={event => endDrag(event, true)} onPointerCancel={event => endDrag(event, false)}>
            <svg viewBox="0 0 10 16" focusable="false"><circle cx="3" cy="3" r="1.5" /><circle cx="7" cy="3" r="1.5" /><circle cx="3" cy="8" r="1.5" /><circle cx="7" cy="8" r="1.5" /><circle cx="3" cy="13" r="1.5" /><circle cx="7" cy="13" r="1.5" /></svg>
          </span>}
          <div className="pc-sortable__content"><strong className="pc-sortable__label" title={item.label}>{item.label}</strong>{item.detail}</div>
          <div className="pc-sortable__actions">
            {index > 0 && <Button size="sm" data-sortable-control="up" aria-label={`Move ${item.label} up`} disabled={disabled}
              onClick={() => move(index, index - 1, ["up", "down"])}>Move up</Button>}
            {index < items.length - 1 && <Button size="sm" data-sortable-control="down" aria-label={`Move ${item.label} down`} disabled={disabled}
              onClick={() => move(index, index + 1, ["down", "up"])}>Move down</Button>}
            {onRemove && <Button size="sm" variant="quiet" data-sortable-control="remove" aria-label={`Remove ${item.label}`} disabled={disabled}
              onClick={() => remove(index)}>Remove</Button>}
          </div>
        </div>
        {renderExtra?.(item, index)}
      </li>)}
    </ol>
    <p className="pc-sortable__status" role="status" aria-live="polite">{announcement}</p>
  </div>;
}
