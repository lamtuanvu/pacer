import { Tabs } from "./SelectionStrip";
import type { ComponentChildren } from "preact";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { cycleDialogFocus } from "./Dialog";
import { Icon, type IconName } from "./icons";
import { Kbd } from "./Kbd";
import { Pill, type PillProps } from "./Pill";

export interface CommandMenuOption {
  id: string; label: string;
  /** Matched parts of the label as [start, end) offsets. */
  ranges?: [number, number][];
  sub?: string; icon?: IconName; leading?: ComponentChildren;
  pill?: { label: string; tone: NonNullable<PillProps["tone"]> };
  /** Key caps for the option's shortcut. */
  keys?: string[];
}
export interface CommandMenuGroup { title: string; options: CommandMenuOption[] }
export interface CommandMenuScope { id: string; label: string; count?: number }

/** The label with its matched ranges marked. Ranges must be sorted and not overlap. */
export function Highlight({ text, ranges = [] }: { text: string; ranges?: [number, number][] }) {
  const parts: ComponentChildren[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * A command palette: a modal combobox over a grouped listbox. Focus stays in the input and the active option is
 * announced through aria-activedescendant. The caller owns the query, scope and options; mounting it opens it and
 * unmounting closes it and returns focus to the element that opened it.
 */
export function CommandMenu({ label, placeholder, query, onQueryChange, prefix, scopes, scope, onScope, groups, empty, enterHint, onActiveChange, modEnterHint, modEnterSoon, modEnterKeys, notice, hints, returnFocus, onBackspaceEmpty, onPick, onClose }: {
  label: string; placeholder: string; query: string; onQueryChange: (query: string) => void;
  /** A badge shown before the input for the active mode, such as "Commands". */
  prefix?: string;
  scopes?: CommandMenuScope[]; scope?: string; onScope?: (id: string) => void;
  groups: CommandMenuGroup[];
  /** Shown above the options when nothing matched. */
  empty?: { title: string; description: string };
  enterHint: string;
  /** Called with the active option id whenever it changes. */
  onActiveChange?: (id: string | undefined) => void;
  /** What ⌘↵ does in this mode, such as "run and keep open". Without it ⌘↵ does nothing and no hint shows. */
  modEnterHint?: string;
  /** The ⌘↵ action does not exist yet: the hint shows with a "Coming soon" label and the key does nothing. */
  modEnterSoon?: boolean;
  /** Key caps for that shortcut, such as ["⌘", "↵"]. */
  modEnterKeys?: string[];
  /** A plain-words line under the list, such as results still loading or sources that could not be searched. Announced politely. */
  notice?: string;
  hints?: ComponentChildren;
  /** The element to focus on close. Defaults to the element focused at open, which WebKit leaves on the body after a mouse click on a button. */
  returnFocus?: () => HTMLElement | null;
  /** Backspace in an empty input, such as to remove the mode chip. */
  onBackspaceEmpty?: () => void;
  onPick: (id: string, options?: { keepOpen: boolean }) => void; onClose: () => void;
}) {
  const uid = useId(), isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const options = groups.flatMap(group => group.options);
  const signature = options.map(option => option.id).join("\n");
  // The position lives in a ref and is settled during render: keys can arrive faster than Preact re-renders, and a new
  // query must reset it before any later key acts on it. Results that change under the same query keep the highlighted option.
  const [, rerender] = useState(0), activeRef = useRef(0), seen = useRef({ query, signature, id: undefined as string | undefined });
  const setActive = (next: number) => { activeRef.current = next; rerender(n => n + 1); };
  if (seen.current.query !== query || seen.current.signature !== signature) {
    const kept = seen.current.query === query && seen.current.id !== undefined ? options.findIndex(option => option.id === seen.current.id) : -1;
    activeRef.current = kept >= 0 ? kept : 0;
  }
  const active = activeRef.current;
  seen.current = { query, signature, id: options[active]?.id };
  const optionId = (index: number) => `${uid}-option-${index}`;
  const activeId = options[active]?.id;
  useEffect(() => { onActiveChange?.(activeId); }, [activeId]);
  useLayoutEffect(() => {
    const element = dialog.current!;
    const invoking = element.ownerDocument.activeElement as HTMLElement | null;
    element.showModal();
    input.current?.focus();
    return () => {
      element.close();
      const target = returnFocus?.() ?? invoking;
      if (target?.isConnected) target.focus();
    };
  }, []);
  useEffect(() => { list.current?.querySelector(`[id="${optionId(active)}"]`)?.scrollIntoView?.({ block: "nearest" }); }, [active, signature]);

  const onKeyDown = (event: KeyboardEvent) => {
    const key = event.key;
    // Enter that confirms an IME candidate (Telex, Pinyin) belongs to the composition, not to the menu.
    if (event.isComposing || event.keyCode === 229) return;
    if (key === "ArrowDown" || key === "ArrowUp") setActive(options.length ? (activeRef.current + (key === "ArrowDown" ? 1 : -1) + options.length) % options.length : 0);
    else if (key === "Backspace" && query === "" && onBackspaceEmpty) { if (event.repeat) return; onBackspaceEmpty(); }
    // Select all works in the input even where the host (a webview without an Edit menu) does not provide it.
    else if (key.toLowerCase() === "a" && (isMac ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey) input.current?.select();
    else if (key === "Home") setActive(0);
    else if (key === "End") setActive(Math.max(0, options.length - 1));
    else if (key === "Enter") {
      const option = options[activeRef.current], mod = event.metaKey || event.ctrlKey;
      if (option && (!mod || (modEnterHint && !modEnterSoon))) onPick(option.id, mod ? { keepOpen: true } : undefined);
    }
    else if (key === "Tab" && scopes?.length && onScope) {
      const at = Math.max(0, scopes.findIndex(item => item.id === scope));
      onScope(scopes[(at + (event.shiftKey ? -1 : 1) + scopes.length) % scopes.length]!.id);
    } else if ((key === "k" || key === "K") && (event.metaKey || event.ctrlKey)) onClose();
    else return;
    event.preventDefault();
  };
  let index = 0;
  return <dialog className="pc-command" ref={dialog} tabIndex={-1} aria-label={label}
    onKeyDown={event => cycleDialogFocus(event.currentTarget, event)}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="pc-command__search">
      <span className="pc-command__icon" aria-hidden="true"><Icon name="search" /></span>
      {prefix && <span className="pc-command__prefix" id={`${uid}-mode`}>{prefix}</span>}
      <input ref={input} className="pc-command__input" type="text" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={`${uid}-list`} aria-describedby={[prefix ? `${uid}-mode` : "", `${uid}-enter`].filter(Boolean).join(" ")}
        aria-activedescendant={options.length ? optionId(active) : undefined} aria-label={label} placeholder={placeholder} autocomplete="off" spellcheck={false}
        value={query} onInput={event => onQueryChange(event.currentTarget.value)} onKeyDown={onKeyDown} />
      <Kbd size="sm">Esc</Kbd>
    </div>
    {scopes && scopes.length > 0 && <div className="pc-command__scopes">
      <Tabs id={`${uid}-scope`} label="Search in" value={scope ?? ""} onChange={value => onScope?.(value)} className="pc-command__tabs"
        options={scopes.map(item => ({ value: item.id, controls: `${uid}-scope-panel`, label: <>{item.label}{item.count !== undefined && <span className="pc-command__count"> {item.count}</span>}</>, buttonProps: { className: "pc-command__scope", onMouseDown: event => event.preventDefault() } }))} />
      <span className="pc-command__spacer" />
      <span className="pc-command__hint"><Kbd size="sm">Tab</Kbd> switch</span>
    </div>}
    <div className="pc-command__panel" role={scopes?.length ? "tabpanel" : undefined} id={`${uid}-scope-panel`} aria-labelledby={scopes?.length ? `${uid}-scope-${scope}-tab` : undefined}>
    {empty && <div className="pc-command__empty" role="status"><strong>{empty.title}</strong><span>{empty.description}</span></div>}
    <div className="pc-command__list" id={`${uid}-list`} role="listbox" aria-label="Results" ref={list}>
      {groups.map((group, at) => <div key={group.title} role="group" aria-labelledby={`${uid}-group-${at}`} className="pc-command__group">
        <span className="pc-command__heading" id={`${uid}-group-${at}`}>{group.title}</span>
        {group.options.map(option => {
          const mine = index++;
          return <div key={option.id} id={optionId(mine)} role="option" aria-selected={mine === active} className="pc-command__option"
            onMouseMove={() => { if (mine !== active) setActive(mine); }} onClick={() => onPick(option.id)}>
            <span className="pc-command__glyph" aria-hidden="true">{option.leading ?? (option.icon && <Icon name={option.icon} />)}</span>
            <span className="pc-command__text">
              <span className="pc-command__label" title={option.label}><Highlight text={option.label} ranges={option.ranges} /></span>
              {option.sub && <span className="pc-command__sub">{option.sub}</span>}
            </span>
            {option.pill && <Pill tone={option.pill.tone}>{option.pill.label}</Pill>}
            {option.keys && <span className="pc-command__keys" aria-hidden="true">{option.keys.map((key, at) => <Kbd key={at} size="sm">{key}</Kbd>)}</span>}
            {mine === active && <span className="pc-command__enter" aria-hidden="true"><Kbd size="sm">↵</Kbd></span>}
          </div>;
        })}
      </div>)}
    </div>
    </div>
    {notice && <div className="pc-command__notice">{notice}</div>}
    {/* A region that is always mounted, so screen readers announce results arriving and sources that could not be searched. */}
    <div className="sr-only" role="status" aria-live="polite">{options.length === 0 ? (empty ? empty.title : "") : `${options.length} ${options.length === 1 ? "result" : "results"}`}{notice ? `. ${notice}` : ""}</div>
    <div className="pc-command__footer">
      <span className="pc-command__hint"><Kbd size="sm">↑</Kbd> <Kbd size="sm">↓</Kbd> move</span>
      <span className="pc-command__hint" id={`${uid}-enter`}><Kbd size="sm">↵</Kbd> {enterHint}</span>
      {modEnterHint && modEnterKeys && <span className="pc-command__hint">{modEnterKeys.map((cap, at) => <Kbd key={at} size="sm">{cap}</Kbd>)} {modEnterHint}{modEnterSoon && <Pill tone="neutral">Coming soon</Pill>}</span>}
      <span className="pc-command__spacer" />
      {hints}
    </div>
  </dialog>;
}
