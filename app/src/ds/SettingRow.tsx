import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import { connectControl, findControl } from "./Controls";
import { Pill, type PillProps } from "./Pill";

export interface SettingStatus { tone: NonNullable<PillProps["tone"]>; label: string }

/** The single settings row grammar: label and description on the left, control on the right. */
export function SettingRow({ label, description, status, children }: {
  label: ComponentChildren; description?: ComponentChildren; status?: SettingStatus; children: ComponentChildren;
}) {
  const base = `setting-${useId()}`, labelId = `${base}-label`, descriptionId = description ? `${base}-description` : undefined;
  // A canonical form control takes the label and description; anything else (segmented groups, buttons,
  // controls already inside their own label) is described by the row.
  const control = findControl(children, ['label']);
  const controlId = control?.props.id ?? `${base}-control`;
  const content = control ? connectControl(children, control, { id: controlId, 'aria-describedby': [control.props['aria-describedby'], descriptionId].filter(Boolean).join(' ') || undefined }) : children;
  return <div className="pc-setting-row" role="group" aria-labelledby={labelId} aria-describedby={control ? undefined : descriptionId}>
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
