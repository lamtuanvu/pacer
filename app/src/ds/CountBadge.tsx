/** Neutral quantity, separate from semantic status pills. */
export function CountBadge({ count, label = count === 1 ? "work item" : "work items" }: { count: number; label?: string }) {
  return <span className="pc-count-badge" aria-label={`${count} ${label}`}>{count}</span>;
}
