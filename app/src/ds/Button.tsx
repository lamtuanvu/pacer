import { classNames as classes } from "./classNames";
// Beautiful UI atoms/Button.tsx adaptation. Source revision and MIT credit: docs/design-system.md.
import type { JSX } from 'preact';
import { forwardRef } from "preact/compat";
import { Icon, type IconName } from "./icons";
import { useDensity } from "./Density";

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'quiet' | 'danger';
interface Appearance { variant?: ButtonVariant; size?: 'md' | 'sm' | 'xs' | 'bar' }
export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement>, Appearance { busy?: boolean }
export interface ButtonLinkProps extends JSX.AnchorHTMLAttributes<HTMLAnchorElement>, Appearance {}
function buttonClasses(variant: ButtonVariant, size: string, density: string, className?: unknown) {
  return classes('pc-btn', `pc-btn--${variant}`, `pc-btn--${size}`, `pc-btn--${density}`, className);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = 'secondary', size = 'md', type = 'button', className, children, busy, disabled, ...rest
}, ref) {
  const density = useDensity();
  return <button {...rest} ref={ref} type={type} disabled={disabled || busy} aria-busy={busy || rest['aria-busy']}
    className={buttonClasses(variant, size, density, className)}>{children}</button>;
});

/** Navigation remains an anchor: supports browser history, modifiers and native destinations. */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink({
  variant = 'secondary', size = 'md', className, children, ...rest
}, ref) {
  const density = useDensity();
  return <a {...rest} ref={ref} className={buttonClasses(variant, size, density, className)}>{children}</a>;
});
export const TextAction = forwardRef<HTMLAnchorElement, JSX.AnchorHTMLAttributes<HTMLAnchorElement>>(function TextAction({ className, children, ...rest }, ref) {
  return <a {...rest} ref={ref} className={classes('pc-text-action', className)}>{children}</a>;
});
export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { 'aria-label': string; icon?: IconName; tone?: 'bad' }>(function IconButton({ icon, tone, children, className, ...props }, ref) {
  return <Button {...props} ref={ref} className={classes('pc-icon-button', tone && `pc-icon-button--${tone}`, className)}>
    {icon && <Icon name={icon} />}{children}
  </Button>;
});
