import type { Tone } from "../../../src/view-model/words";
import { Icon, type IconName } from "./icons";

export interface MetaItem { icon: IconName; text: string; tone?: Tone; emphasis?: boolean; title?: string }

export function MetaRow({ items, label }: { items: MetaItem[]; label: string }) {
  const visible = items.filter(item => item.text.trim().length > 0);
  if (!visible.length) return null;
  return <div className="pc-meta-row" role="group" aria-label={label}>
    {visible.map((item, index) => <span key={index}
      className={`pc-meta-row__item pc-meta-row__item--${item.tone ?? 'neutral'}${item.emphasis ? ' pc-meta-row__item--emphasis' : ''}`}
      title={item.title ?? item.text}>
      <Icon name={item.icon} /><span className="pc-meta-row__text">{item.text}</span>
    </span>)}
  </div>;
}
