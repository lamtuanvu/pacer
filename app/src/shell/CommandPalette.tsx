import { useEffect, useMemo, useState } from "preact/hooks";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import { CommandMenu, type CommandMenuGroup } from "../ds/CommandMenu";
import { Kbd } from "../ds/Kbd";
import { commands as commandRegistry } from "../keys/instance";
import { keyCaps, type CommandRegistry } from "../keys/commands";
import { buildMenu, SCOPES, ASK_ENABLED, parseQuery, type MenuItem, type MenuScope } from "../model/command-search";

import { useNavigation } from "../navigation";

const RECENT_KEY = "pacer.command.recent";
export function loadRecent(): string[] {
  try { const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []; }
  catch { return []; }
}
export function rememberRecent(id: string, before = loadRecent()): string[] {
  const next = [id, ...before.filter(other => other !== id)].slice(0, 8);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* recents are a convenience */ }
  return next;
}

/** The ⌘K command menu over the app's snapshot and the one command registry. Mount it to open it. */
export function CommandPalette({ snapshot, registry = commandRegistry, now: fixedNow, returnFocus, close }: { snapshot: ClientSnapshot | null; registry?: CommandRegistry; now?: number; returnFocus?: () => HTMLElement | null; close: () => void }) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<MenuScope>("all");
  const [recent] = useState(loadRecent);
  const { navigate } = useNavigation();
  // Commands come and go with the screen (a panel toggle exists only where its panel does), so follow the registry while open.
  const [revision, setRevision] = useState(0);
  useEffect(() => registry.subscribe(() => setRevision(n => n + 1)), [registry]);
  const commands = useMemo(() => registry.list(), [registry, revision]);
  const [opened] = useState(() => Date.now() / 1000), now = fixedNow ?? opened;
  const menu = useMemo(() => buildMenu({ query, scope, snapshot, commands, recent, now }), [query, scope, snapshot, commands, recent, now]);
  // A new mode starts at All; within search, an empty scope falls back to All in buildMenu.
  useEffect(() => { setScope("all"); }, [parseQuery(query).mode]);
  const byId = new Map<string, MenuItem>(menu.groups.flatMap(group => group.items.map(item => [item.id, item] as const)));
  const groups: CommandMenuGroup[] = menu.groups.map(group => ({ title: group.title, options: group.items.map(item => ({
    id: item.id, label: item.title, ranges: item.ranges, sub: item.sub, icon: item.icon, pill: item.pill,
    keys: item.command?.keys ? keyCaps(item.command.keys) : undefined,
  })) }));
  const pick = (id: string) => {
    const item = byId.get(id);
    if (!item) return;
    close();
    rememberRecent(item.id, recent);
    // After the menu has closed, so a command that opens a dialog starts from the restored focus.
    if (item.command) setTimeout(item.command.run, 0);
    else if (item.target) navigate(item.target);
  };
  const searching = menu.mode === "search";
  return <CommandMenu label="Search tasks, machines, repos or run a command" placeholder="Search tasks, machines, repos or type > for commands"
    query={query} onQueryChange={setQuery} prefix={menu.mode === "commands" ? "Commands" : menu.mode === "ask" ? "Ask" : undefined}
    scopes={searching ? SCOPES.map(item => ({ ...item, count: menu.counts[item.id] })) : undefined} scope={menu.scope} onScope={id => setScope(id as MenuScope)}
    groups={groups} empty={menu.empty ? { title: `Nothing matches “${parseQuery(query).text}”`, description: "Try fewer words, another scope, or turn it into work:" } : undefined}
    enterHint={menu.enterHint} hints={<span className="pc-command__hint"><Kbd>&gt;</Kbd> commands{ASK_ENABLED && <> · <Kbd>?</Kbd> ask assistant</>}</span>}
    onPick={pick} onClose={close} returnFocus={returnFocus} />;
}
