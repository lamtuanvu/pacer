import { useEffect, useId, useRef } from "preact/hooks";
import { TextAction } from "./Button";
import { Icon, type IconName } from "./icons";
import type { PillProps } from "./Pill";

export interface SettingsNavItem { id: string; label: string; href: string; icon: IconName; current?: boolean; badge?: { text: string; label?: string; tone?: PillProps["tone"] } }
export interface SettingsNavGroup { id: string; label: string; items: readonly SettingsNavItem[] }

/** Grouped settings menu. Links stay in document order, so Tab follows the groups top to bottom. */
export function SettingsNav({ label, groups }: { label: string; groups: readonly SettingsNavGroup[] }) {
  const base = `settings-nav-${useId()}`, nav = useRef<HTMLElement>(null);
  const current = groups.flatMap(group => group.items).find(item => item.current)?.id;
  // In the narrow horizontal strip the current page may start off-screen.
  useEffect(() => { nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest", inline: "center" }); }, [current]);
  // Group labels name their lists without adding headings ahead of the page's own.
  return <nav aria-label={label} className="pc-settings-nav" ref={nav}>
    {groups.map(group => <div key={group.id} className="pc-settings-nav__group">
      <span id={`${base}-${group.id}`} className="pc-settings-nav__heading">{group.label}</span>
      <ul aria-labelledby={`${base}-${group.id}`} className="pc-settings-nav__list">
        {group.items.map(item => <li key={item.id}>
          <TextAction href={item.href} className={`pc-settings-nav__item${item.current ? " on" : ""}`} aria-current={item.current ? "page" : undefined}>
            <Icon name={item.icon}/>{item.label}
            {item.badge && <Badge {...item.badge}/>}
          </TextAction>
        </li>)}
      </ul>
    </div>)}
  </nav>;
}

/** Glyph and count badges keep their words for assistive technology; the title repeats them for pointer users. */
function Badge({ text, label = text, tone = "neutral" }: NonNullable<SettingsNavItem["badge"]>) {
  return <span className={`pc-settings-nav__badge pc-settings-nav__badge--${tone}`} title={label}>
    {label === text ? text : <><span aria-hidden="true">{text}</span><span className="sr-only">{label}</span></>}
  </span>;
}
