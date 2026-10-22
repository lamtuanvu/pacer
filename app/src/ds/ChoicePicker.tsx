import { forwardRef } from 'preact/compat';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { Button } from './Button';
import { classNames as classes } from './classNames';
import { useDensity } from './Density';

export interface ChoiceOption {
  value: string;
  label: string;
  disabled?: boolean;
  reason?: string;
  description?: string;
}

export interface ChoicePickerProps {
  value: string;
  options: readonly ChoiceOption[];
  onValueChange(value: string): void;
  placeholder?: string;
  searchable?: boolean;
  required?: boolean;
  disabled?: boolean;
  name?: string;
  id?: string;
  className?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-label'?: string;
}

/** Controlled single-choice field; the trigger is the labeled and focusable control. */
export const ChoicePicker = forwardRef<HTMLButtonElement, ChoicePickerProps>(function ChoicePicker({
  value, options, onValueChange, placeholder = 'Choose…', searchable,
  required, disabled, name, id, className, ...aria
}, ref) {
  const generated = useId();
  const density = useDensity();
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listbox = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const visible = options.filter(option => !searchable || `${option.label} ${option.description ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const available = visible.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
  const selected = options.find(option => option.value === value);
  const menuId = `${id ?? generated}-options`;
  const close = (restoreFocus = false) => {
    setOpen(false);
    setQuery('');
    if (restoreFocus) trigger.current?.focus();
  };
  const begin = (index?: number) => {
    if (disabled) return;
    document.dispatchEvent(new CustomEvent('pacer-choice-picker-open', { detail: root.current }));
    setOpen(true);
    setActive(index ?? options.findIndex(option => option.value === value && !option.disabled));
    requestAnimationFrame(() => (searchable ? search.current : listbox.current)?.focus());
  };
  const choose = (option: ChoiceOption) => {
    if (option.disabled) return;
    onValueChange(option.value);
    close(true);
  };
  const move = (key: string) => {
    if (!available.length) return;
    const current = available.indexOf(active);
    const next = key === 'Home' ? 0 : key === 'End' ? available.length - 1
      : key === 'ArrowDown' ? (current + 1) % available.length
      : (current < 0 ? available.length - 1 : current - 1 + available.length) % available.length;
    setActive(available[next]!);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab' && open) {
      close();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open) begin(event.key === 'End' ? available.at(-1) : available[0]);
      else move(event.key);
    } else if (event.key === 'Enter' || (event.key === ' ' && event.target !== search.current)) {
      if (open) {
        event.preventDefault();
        if (active >= 0 && visible[active]) choose(visible[active]);
      } else if (!searchable) {
        event.preventDefault();
        begin();
      }
    } else if (!searchable && event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const match = options.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
      if (match >= 0) { event.preventDefault(); begin(match); }
    }
  };
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    const other = (event: Event) => { if ((event as CustomEvent).detail !== root.current) close(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('pacer-choice-picker-open', other);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('pacer-choice-picker-open', other);
    };
  }, []);
  return <span ref={root} className={classes('pc-choice-picker', `pc-choice-picker--${density}`, className)}>
    <Button ref={(node: HTMLButtonElement | null) => {
      trigger.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    }} id={id} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined}
      aria-required={required || undefined} {...aria} onClick={() => open ? close() : begin()}
      onKeyDown={onKeyDown as never} className="pc-choice-picker__trigger">
      <span className="pc-choice-picker__value">{selected?.label ?? placeholder}</span>
      <span className="pc-choice-picker__chevron" aria-hidden="true" />
    </Button>
    {open && <span className="pc-choice-picker__popover" onKeyDown={onKeyDown as never}>
      {searchable && <input ref={search} className="pc-input pc-choice-picker__search" type="search" role="searchbox"
        aria-label="Search choices" aria-controls={menuId} aria-activedescendant={active >= 0 ? `${menuId}-${active}` : undefined}
        value={query} onInput={event => { setQuery(event.currentTarget.value); setActive(-1); }} />}
      <span ref={listbox} id={menuId} role="listbox" tabIndex={-1} aria-labelledby={id}
        aria-label={id ? undefined : aria['aria-label'] ?? 'Choices'}
        aria-activedescendant={active >= 0 ? `${menuId}-${active}` : undefined} className="pc-choice-picker__options">
        {visible.map((option, index) => <span key={option.value} role="option" id={`${menuId}-${index}`}
          aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
          className={classes('pc-choice-picker__option', index === active && 'pc-choice-picker__option--active')}
          onPointerMove={() => { if (!option.disabled) setActive(index); }} onClick={() => choose(option)}>
          <span className="pc-choice-picker__option-label">{option.label}</span>
          {(option.description || option.reason) && <small>{option.reason ?? option.description}</small>}
        </span>)}
        {!visible.length && <span className="pc-choice-picker__empty">No matching choices</span>}
      </span>
    </span>}
    {name && <input type="hidden" name={name} value={selected?.value ?? ''} />}
  </span>;
});
