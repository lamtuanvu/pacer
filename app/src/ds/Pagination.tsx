import { Button } from "./Button";

/** Controlled list navigation; the caller owns its filtered rows and page state. */
export function Pagination({ label, page, pageSize, total, onChange }: {
  label: string; page: number; pageSize: number; total: number; onChange: (page: number) => void;
}) {
  if (!total) return null;
  const change = (button: HTMLButtonElement, next: number) => {
    // A boundary button can disappear after paging; keep keyboard focus in this list.
    button.closest<HTMLElement>("nav")?.focus();
    onChange(next);
  };
  return <nav className="pc-pagination" tabIndex={-1} aria-label={`${label} pages`}>
    <span className="muted" role="status" aria-live="polite">{page * pageSize + 1}–{Math.min(total, (page + 1) * pageSize)} of {total}</span>
    <span className="grow" />
    {page > 0 && <Button size="sm" onClick={event => change(event.currentTarget, page - 1)}>Previous</Button>}
    {(page + 1) * pageSize < total && <Button size="sm" onClick={event => change(event.currentTarget, page + 1)}>Next</Button>}
  </nav>;
}
