/** Canonical primitives accept layout classes without repeating their owned classes. */
export function classNames(...values: unknown[]): string {
  return [...new Set(values.filter(Boolean).flatMap(value => String(value).split(/\s+/)))].join(' ');
}
