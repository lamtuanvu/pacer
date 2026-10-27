import { useEffect, useRef, useState } from "preact/hooks";
import { Button, IconButton } from "./Button";
import { CountBadge } from "./CountBadge";
import { Icon, type IconName } from "./icons";
import { tabStep } from "./Patterns";

export interface PanelTab { id: string; label: string; icon?: IconName; badge?: number }
const content = (tab: PanelTab) => <>{tab.icon && <Icon name={tab.icon} />}<span className="pc-panel-tabs__label">{tab.label}</span>
  {!!tab.badge && <CountBadge count={tab.badge} label={tab.badge === 1 ? "item" : "items"} />}</>;

/** Compact panel tablist. Tabs past maxVisible move into a "+N" menu; the selected tab always stays in the strip. */
export function PanelTabs({ label, tabs, value, onChange, maxVisible = 4 }: {
  label: string; tabs: readonly PanelTab[]; value: string; onChange: (id: string) => void; maxVisible?: number;
}) {
  const [menu, setMenu] = useState(false);
  const list = useRef<HTMLDivElement>(null), more = useRef<HTMLButtonElement>(null), wrap = useRef<HTMLDivElement>(null);
  const focusSelected = useRef(false);
  const chosen = tabs.findIndex(tab => tab.id === value);
  const visible = chosen < maxVisible ? tabs.slice(0, maxVisible) : [...tabs.slice(0, maxVisible - 1), tabs[chosen]!];
  const hidden = tabs.filter(tab => !visible.includes(tab));
  const current = visible.some(tab => tab.id === value) ? value : visible[0]?.id;
  useEffect(() => {
    if (menu) wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    else if (focusSelected.current) list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    focusSelected.current = false;
  }, [menu, value]);
  const close = () => { setMenu(false); more.current?.focus(); };
  return <div className="pc-panel-tabs">
    <div ref={list} role="tablist" aria-label={label} className="pc-tabs pc-panel-tabs__list">
      {visible.map((tab, at) => <Button key={tab.id} size="sm" role="tab" aria-selected={tab.id === current} tabIndex={tab.id === current ? 0 : -1} title={tab.label}
        onClick={() => onChange(tab.id)} onKeyDown={event => {
          const next = tabStep(event.key, at, visible.length);
          if (next === undefined) return;
          event.preventDefault();
          onChange(visible[next]!.id);
          list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
        }}>{content(tab)}</Button>)}
    </div>
    {hidden.length > 0 && <div ref={wrap} className="pc-panel-tabs__more" onFocusOut={event => {
      if (!wrap.current?.contains(event.relatedTarget as Node | null)) setMenu(false);
    }}>
      <IconButton ref={more} size="sm" variant="quiet" aria-label={`+${hidden.length} more tabs`} aria-haspopup="menu" aria-expanded={menu}
        onClick={() => setMenu(!menu)}>+{hidden.length}</IconButton>
      {menu && <div role="menu" aria-label={`More ${label}`} className="pc-panel-tabs__menu" onKeyDown={event => {
        const items = [...wrap.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
        const at = items.indexOf(document.activeElement as HTMLElement);
        const next = event.key === "ArrowDown" ? (at + 1) % items.length : event.key === "ArrowUp" ? (at + items.length - 1) % items.length
          : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : undefined;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        else if (next !== undefined) { event.preventDefault(); items[next]!.focus(); }
      }}>
        {hidden.map(tab => <Button key={tab.id} size="sm" variant="quiet" role="menuitem" tabIndex={-1}
          onClick={() => { focusSelected.current = true; setMenu(false); onChange(tab.id); }}>{content(tab)}</Button>)}
      </div>}
    </div>}
  </div>;
}
