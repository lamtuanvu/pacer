import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import { Checkbox, Switch, connectControl, findControl } from "./Controls";
import { Pill, type PillProps } from "./Pill";

export interface SettingStatus { tone: NonNullable<PillProps["tone"]>; label: string }

/** The single settings row grammar: label and description on the left, control on the right. */
export function SettingRow({ label, description, status, children, layout }: {
  layout?: "stacked"; label: ComponentChildren; description?: ComponentChildren; status?: SettingStatus; children: ComponentChildren;
}) {
  const base = `setting-${useId()}`, labelId = `${base}-label`, descriptionId = description ? `${base}-description` : undefined;
  // A canonical form control takes the row label and description. Anything else (segmented groups, buttons,
  // controls inside their own label or with their own label prop) keeps its name; the row group carries both.
  const found = findControl(children, ['label']);
  const control = found && !(found.props as { label?: unknown }).label ? found : undefined;
  const controlId = control?.props.id ?? `${base}-control`;
  // A bare toggle sits in an empty DS checkbox label so it keeps the settings and touch hit area.
  const toggle = control && (control.type === Checkbox || control.type === Switch);
  const content = control ? connectControl(children, control, { id: controlId, 'aria-describedby': [control.props['aria-describedby'], descriptionId].filter(Boolean).join(' ') || undefined }, toggle ? node => <label className="pc-checkbox pc-checkbox--bare">{node}</label> : undefined) : children;
  const group = control ? {} : { role: "group" as const, "aria-labelledby": labelId, "aria-describedby": descriptionId };
  return <div className={`pc-setting-row${layout?` pc-setting-row--${layout}`:""}`} {...group}>
    <div className="pc-setting-row__text">
      <div className="pc-setting-row__heading">
        {control ? <label id={labelId} htmlFor={controlId} className="pc-setting-row__label">{label}</label> : <span id={labelId} className="pc-setting-row__label">{label}</span>}
        {status && <Pill tone={status.tone}>{status.label}</Pill>}
      </div>
      {description && <p id={descriptionId} className="pc-setting-row__description">{description}</p>}
    </div>
    <div className="pc-setting-row__control">{content}</div>
  </div>;
}
