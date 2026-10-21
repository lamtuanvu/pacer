/** Route changes ask the active draft owner before unmounting it. */
let guard: (() => Promise<boolean>) | undefined;
export function registerNavigationGuard(next: () => Promise<boolean>): () => void {
  guard = next;
  return () => { if (guard === next) guard = undefined; };
}
export function canLeaveScreen(): Promise<boolean> { return guard ? guard() : Promise.resolve(true); }
