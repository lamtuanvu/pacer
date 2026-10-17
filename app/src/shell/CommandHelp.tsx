import { Kbd } from "../ds/Kbd";
import type { KeyRegistry } from "../keys/registry";
import { Dialog } from "../screens/task-shared";
const SCOPES: Record<string, string> = { global: "Anywhere", overview: "Overview", review: "Review", sessions: "Sessions" };
/** The ? overlay: every registered shortcut, grouped by where it works. */
export function CommandHelp({ registry, close }: { registry: KeyRegistry; close: () => void }) {
  const groups = new Map<string, { keys: string; label: string }[]>();
  for (const s of registry.list()) groups.set(s.scope, [...(groups.get(s.scope) ?? []), s]);
  return <Dialog title="Keyboard shortcuts" close={close}>
    {[...groups].map(([scope, items]) => <section key={scope} className="pc-keys"><h2>{SCOPES[scope] ?? scope}</h2>
      <dl>{items.map(s => <><dt><Kbd>{s.keys}</Kbd></dt><dd>{s.label}</dd></>)}</dl></section>)}
  </Dialog>;
}
