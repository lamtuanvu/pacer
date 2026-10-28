import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Button } from "./Button";
import { TextInput } from "./Controls";
import { CountBadge } from "./CountBadge";

export interface SearchPickerOption {
  value: string | null;
  label: string;
  description?: string;
  count?: number;
  searchText?: string;
}

/** Beautiful UI Button/TextRow grammar, with local search and native pressed buttons. */
export function SearchPicker({ label, searchLabel, placeholder, emptyLabel, value, options, onChange, align: preferredAlign = "end" }: {
  label: string;
  searchLabel: string;
  placeholder: string;
  emptyLabel: string;
  value: string | null;
  options: SearchPickerOption[];
  onChange: (value: string | null) => void;
  /** Preferred popover edge; it still flips when that side would overflow the viewport. */
  align?: "start" | "end";
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const previousValue = useRef(value);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [alignStart, setAlignStart] = useState(false);
  const matches = options.filter(option => `${option.label} ${option.description ?? ""} ${option.searchText ?? ""}`
    .toLowerCase().includes(search.trim().toLowerCase()));
  const close = (restoreFocus = false) => {
    setOpen(false);
    setSearch("");
    if (restoreFocus) trigger.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    searchInput.current?.focus();
    const align = () => {
      const bounds = root.current?.getBoundingClientRect();
      const popup = root.current?.querySelector<HTMLElement>(".pc-search-picker__popover");
      if (!bounds || !popup) return;
      const width = popup.getBoundingClientRect().width;
      setAlignStart(preferredAlign === "start" ? bounds.left + width <= innerWidth : bounds.right < width);
    };
    align();
    const observer = new ResizeObserver(align);
    if (root.current) observer.observe(root.current);
    window.addEventListener("resize", align);
    return () => { observer.disconnect(); window.removeEventListener("resize", align); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useLayoutEffect(() => {
    if (previousValue.current !== value) close();
    previousValue.current = value;
  }, [value]);

  return <div ref={root} className="pc-search-picker" data-align={alignStart ? "start" : "end"}
    onBlur={event => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close();
    }} onKeyDown={event => {
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      const rows = Array.from(root.current?.querySelectorAll<HTMLButtonElement>(".pc-search-picker__option") ?? []);
      const at = rows.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (at + 1) % rows.length
        : event.key === "ArrowUp" ? (at < 0 ? rows.length - 1 : (at + rows.length - 1) % rows.length)
        : at >= 0 && event.key === "Home" ? 0
        : at >= 0 && event.key === "End" ? rows.length - 1 : undefined;
      if (next !== undefined && rows.length) {
        event.preventDefault();
        rows[next]?.focus();
      }
    }}>
    <Button ref={trigger} size="sm" className="pc-chip" aria-expanded={open} aria-controls={id}
      onClick={() => { if (open) close(); else { setSearch(""); setOpen(true); } }}>
      {label}<span aria-hidden="true">⌄</span>
    </Button>
    {open && <div className="pc-search-picker__popover" id={id}>
      <div className="pc-search-picker__search">
        <TextInput ref={searchInput} type="search" aria-label={searchLabel} placeholder={placeholder}
          value={search} onInput={event => setSearch(event.currentTarget.value)} />
      </div>
      <div className="pc-search-picker__options" role="group" aria-label={searchLabel}>
        {matches.map(option => <Button key={option.value ?? "all"} variant="quiet" className="pc-search-picker__option"
          title={option.description ? `${option.description}/${option.label}` : option.label}
          aria-pressed={option.value === value} onClick={() => { close(true); onChange(option.value); }}>
          <span className="pc-search-picker__check" aria-hidden="true">{option.value === value ? "✓" : ""}</span>
          <span className="pc-search-picker__identity">
            <span className="pc-search-picker__label">{option.label}</span>
            {option.description && <span className="pc-search-picker__description">{option.description}</span>}
          </span>
          {option.count !== undefined && <CountBadge count={option.count} />}
        </Button>)}
        {!matches.length && <p className="pc-search-picker__empty" role="status">{emptyLabel}</p>}
      </div>
    </div>}
  </div>;
}
