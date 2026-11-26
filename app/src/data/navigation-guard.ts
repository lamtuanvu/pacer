/** Route changes ask the active draft owner before unmounting it. `target` is the hash being opened, when known. */
let guard: ((target?: string) => Promise<boolean>) | undefined;
export function registerNavigationGuard(next: (target?: string) => Promise<boolean>): () => void {
  guard = next;
  return () => { if (guard === next) guard = undefined; };
}
export function canLeaveScreen(target?: string): Promise<boolean> { return guard ? guard(target) : Promise.resolve(true); }
