import { SectionHeading } from "../ds/SectionHeading";
import { Fragment } from "preact";
import { Kbd } from "../ds/Kbd";
import { keyCaps } from "../keys/commands";
import type { KeyRegistry } from "../keys/registry";
import { Dialog } from "../screens/task-shared";
const SCOPES: Record<string, string> = { global: "Anywhere", overview: "Overview", review: "Review", sessions: "Sessions", settings: "Settings" };
/** The ? overlay: every registered shortcut, grouped by where it works. */
/** `mac` picks the symbols on macOS (⌘ ⌃) or the words elsewhere; by default the platform decides. */
export function CommandHelp({ registry, close, mac }: { registry: KeyRegistry; close: () => void; mac?: boolean }) {
  const groups = new Map<string, { keys: string; label: string }[]>();
  // One line per key: Escape is registered once per settings screen but means one thing.
  const seen = new Set<string>();
  for (const s of registry.list()) { if (seen.has(`${s.keys}|${s.label}`)) continue; seen.add(`${s.keys}|${s.label}`); groups.set(s.scope, [...(groups.get(s.scope) ?? []), s]); }
  return <Dialog title="Keyboard shortcuts" close={close}>
    {[...groups].map(([scope, items]) => <section key={scope} className="pc-keys"><SectionHeading>{SCOPES[scope] ?? scope}</SectionHeading>
      <dl>{items.map(s => <Fragment key={`${s.keys}|${s.label}`}><dt><Kbd>{s.keys.includes("-") && s.keys.length > 1 ? keyCaps(s.keys, mac).join(" ") : s.keys}</Kbd></dt><dd>{s.label}</dd></Fragment>)}</dl></section>)}
  </Dialog>;
}
