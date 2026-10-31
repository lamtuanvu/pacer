import type { JSX } from "preact";
import { Icon } from "./icons";
import { classNames } from "./classNames";

/** Board kids chip shared by task cards and the session navigator. */
export function SubtaskToggle({ className, children, ...props }: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} type="button" className={classNames("pc-task-card__toggle", className)}>
    <Icon name="branch" />{children}<span className="pc-task-card__chevron" aria-hidden="true"><Icon name="chevron-down" /></span>
  </button>;
}
