import { TextAction } from "./Button";
import { Icon, type IconName } from "./icons";
import type { PillProps } from "./Pill";

export interface SettingsNavItem { id: string; label: string; href: string; icon: IconName; current?: boolean; badge?: { text: string; label?: string; tone?: PillProps["tone"] } }
export interface SettingsNavGroup { id: string; label: string; items: readonly SettingsNavItem[] }

/** Grouped settings menu. Links stay in document order, so Tab follows the groups top to bottom. */
export function SettingsNav({ label, groups }: { label: string; groups: readonly SettingsNavGroup[] }) {
  return <nav aria-label={label} className="pc-settings-nav">
    {groups.map(group => <div key={group.id} className="pc-settings-nav__group">
      <h2 id={`settings-nav-${group.id}`} className="pc-settings-nav__heading">{group.label}</h2>
      <ul aria-labelledby={`settings-nav-${group.id}`} className="pc-settings-nav__list">
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
