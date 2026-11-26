import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import { useUniqueId as useId } from "./useUniqueId";
import { classNames } from "./classNames";
import { useDensity } from "./Density";
import { Icon } from "./icons";

export interface ComboboxOption {
  value: string;
  /** Secondary text under the value, also searched. */
  description?: string;
  /** Trailing content such as a size badge; decorative text stays in the option's name. */
  meta?: ComponentChildren;
  /** Options sharing a group render under one heading, in first-seen order. */
  group?: string;
}

/** A row of the open list: a listed option, or the typed text when `allowCustom` accepts it. */
export interface ComboboxItem { option: ComboboxOption; custom: boolean }

/** Case-insensitive match on value and description; the typed text is offered last unless it is already listed. */
export function comboboxItems(options: readonly ComboboxOption[], query: string, allowCustom: boolean): ComboboxItem[] {
  const text = query.trim(), needle = text.toLowerCase();
  const items = options.filter(option => `${option.value} ${option.description ?? ""}`.toLowerCase().includes(needle)).map(option => ({ option, custom: false }));
  if (allowCustom && text && !options.some(option => option.value === text)) items.push({ option: { value: text }, custom: true });
  return items;
}

/** Arrow keys move the active row and wrap; other keys leave it unchanged. */
export function comboboxStep(key: string, active: number, count: number): number | undefined {
  if (!count) return undefined;
  if (key === "ArrowDown") return active < 0 ? 0 : (active + 1) % count;
  if (key === "ArrowUp") return active < 0 ? count - 1 : (active + count - 1) % count;
  return undefined;
}

/**
 * Editable combobox with an inline listbox (WAI-ARIA combobox pattern): typing filters, arrows move the
 * active option while focus stays in the field, Enter picks it, Escape closes the list and then clears the text.
 * Picking keeps focus and the list open so several values can be added in a row.
 */
export function Combobox({ label, options, onPick, placeholder, source, hint, emptyLabel = "No matches", customLabel = value => `Add ${value}`, pickedLabel = value => `Added ${value}`, allowCustom = true, disabled, mono = false, className }: {
  label: string;
  options: readonly ComboboxOption[];
  onPick: (value: string, custom: boolean) => void;
  placeholder?: string;
  /** Short trailing text inside the field, such as where the options come from. */
  source?: ComponentChildren;
  /** Help shown under the open list. */
  hint?: ComponentChildren;
  emptyLabel?: string;
  customLabel?: (value: string) => string;
  pickedLabel?: (value: string) => string;
  allowCustom?: boolean;
  disabled?: boolean;
  /** Values are identifiers (model ids, paths): show them in the code face. */
  mono?: boolean;
  className?: string;
}) {
  const id = useId(), inputId = `combobox-${id}`, listId = `${inputId}-list`;
  const density = useDensity();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(""), [open, setOpen] = useState(false), [active, setActive] = useState(-1), [announcement, announce] = useState("");
  const items = comboboxItems(options, query, allowCustom);
  const current = active >= 0 && active < items.length ? active : -1;
  const optionId = (index: number) => `${inputId}-option-${index}`;
  const pick = (index: number) => {
    const item = items[index];
    if (!item) return;
    onPick(item.option.value, item.custom);
    announce(pickedLabel(item.option.value));
    setQuery(""); setActive(-1); setOpen(true);
    input.current?.focus();
  };
  const groups: { name?: string; entries: { item: ComboboxItem; index: number }[] }[] = [];
  items.forEach((item, index) => {
    const name = item.custom ? undefined : item.option.group;
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.entries.push({ item, index }); else groups.push({ name, entries: [{ item, index }] });
  });
  const row = ({ item, index }: { item: ComboboxItem; index: number }) => <div key={item.custom ? `custom:${item.option.value}` : item.option.value} id={optionId(index)} role="option" aria-selected={index === current}
    className={classNames("pc-combobox__option", index === current && "pc-combobox__option--active")}
    onMouseDown={event => event.preventDefault()} onMouseMove={() => { if (index !== current) setActive(index); }} onClick={() => pick(index)}>
    <span className="pc-combobox__identity">
      <span className={classNames("pc-combobox__value", mono && "pc-combobox__value--mono")}>{item.custom ? customLabel(item.option.value) : item.option.value}</span>
      {item.option.description && <span className="pc-combobox__description">{item.option.description}</span>}
    </span>
    {item.option.meta && <span className="pc-combobox__meta">{item.option.meta}</span>}
  </div>;
  return <div className={classNames("pc-combobox", `pc-combobox--${density}`, className)}>
    <label className="pc-combobox__label" htmlFor={inputId}>{label}</label>
    <div className={classNames("pc-combobox__box", open && "pc-combobox__box--open")}>
      <div className="pc-combobox__field">
        <Icon name="search" />
        <input ref={input} id={inputId} className="pc-combobox__input" type="text" role="combobox" autoComplete="off" spellcheck={false}
          aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open && current >= 0 ? optionId(current) : undefined}
          placeholder={placeholder} value={query} disabled={disabled}
          onFocus={() => setOpen(true)}
          onBlur={() => { setOpen(false); setActive(-1); }}
          onInput={event => { setQuery(event.currentTarget.value); setOpen(true); setActive(event.currentTarget.value.trim() ? 0 : -1); }}
          onKeyDown={event => {
            if (event.key === "Escape") {
              if (!open && !query) return;
              event.preventDefault(); event.stopPropagation();
              if (open) { setOpen(false); setActive(-1); } else setQuery("");
              return;
            }
            if (event.key === "Enter") {
              if (!open) return;
              event.preventDefault();
              pick(current >= 0 ? current : query.trim() ? 0 : -1);
              return;
            }
            const next = comboboxStep(event.key, current, items.length);
            if (next === undefined) return;
            event.preventDefault();
            setOpen(true); setActive(next);
            document.getElementById(optionId(next))?.scrollIntoView?.({ block: "nearest" });
          }} />
        {source && <span className="pc-combobox__source">{source}</span>}
      </div>
      <div id={listId} role="listbox" aria-label={label} className="pc-combobox__list" hidden={!open}>
        {groups.map((group, index) => group.name
          ? <div key={`group:${group.name}:${index}`} role="group" aria-labelledby={`${listId}-group-${index}`} className="pc-combobox__group">
              <div id={`${listId}-group-${index}`} role="presentation" className="pc-combobox__heading">{group.name}</div>
              {group.entries.map(row)}
            </div>
          : group.entries.map(row))}
        {!items.length && <div role="presentation" className="pc-combobox__empty">{emptyLabel}</div>}
      </div>
      {open && hint && <p className="pc-combobox__hint">{hint}</p>}
    </div>
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
  </div>;
}
