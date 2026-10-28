import { useEffect, useMemo, useState } from "preact/hooks";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import { AgentMark } from "../ds/AgentMark";
import { CommandMenu, type CommandMenuGroup } from "../ds/CommandMenu";
import { Kbd } from "../ds/Kbd";
import { commands as commandRegistry } from "../keys/instance";
import { keyCaps, type CommandRegistry } from "../keys/commands";
import type { FilesSearchResult } from "../../../src/core/files-search";
import { buildMenu, scopesFor, ASK_ENABLED, parseQuery, type FilesState, type MenuItem, type MenuScope } from "../model/command-search";
import { useTaskContext } from "../screens/task-shared";
import { useNotifications } from "../data/notification-context";
import { useNavigation } from "../navigation";

/** Typing waits this long before a files search starts; the service also caches a repeated read for a few seconds. */
export const FILES_DEBOUNCE_MS = 200;

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
  // The leading ">" is the chip, not text ("?" ask stays in the text while it is gated off): the input shows only what follows it, and Backspace on an empty input removes the chip.
  const [text, setText] = useState(""), [commandMode, setCommandMode] = useState(false);
  const query = commandMode ? `>${text}` : text;
  const edit = (next: string) => {
    if (!commandMode && next.startsWith(">")) { setCommandMode(true); setText(next.slice(1)); } else setText(next);
  };
  const [scope, setScope] = useState<MenuScope>("all");
  const [recent] = useState(loadRecent);
  const { navigate } = useNavigation();
  const { api, state } = useTaskContext();
  // Commands come and go with the screen (a panel toggle exists only where its panel does), so follow the registry while open.
  const [revision, setRevision] = useState(0);
  useEffect(() => registry.subscribe(() => setRevision(n => n + 1)), [registry]);
  const commands = useMemo(() => registry.list(), [registry, revision]);
  const [opened] = useState(() => Date.now() / 1000), now = fixedNow ?? opened;
  // Files come from the service (an existing read-only operation), debounced, and only while searching. An answer counts only for the query it was asked for.
  const filesOn = state.features.ops.has("files.search");
  const needle = parseQuery(query).mode === "search" ? text.trim().slice(0, 200) : "";
  const [answer, setAnswer] = useState<{ query: string; result: FilesSearchResult | "error" } | null>(null);
  useEffect(() => {
    if (!filesOn || !needle) return;
    let live = true;
    const timer = setTimeout(() => {
      api.call<FilesSearchResult>("files.search", { query: needle, limit: 20 }).then(
        result => { if (live) setAnswer({ query: needle, result }); },
        () => { if (live) setAnswer({ query: needle, result: "error" }); });
    }, FILES_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [needle, filesOn, api]);
  const files: FilesState = !filesOn || !needle ? { status: "off" } : answer?.query !== needle ? { status: "loading" } : answer.result === "error" ? { status: "error" } : { status: "ready", result: answer.result };
  const menu = useMemo(() => buildMenu({ query, scope, snapshot, commands, recent, now, files }), [query, scope, snapshot, commands, recent, now, files.status, (files as { result?: unknown }).result]);
  // A new mode starts at All; within search, an empty scope falls back to All in buildMenu.
  useEffect(() => { setScope("all"); }, [parseQuery(query).mode]);
  const byId = new Map<string, MenuItem>(menu.groups.flatMap(group => group.items.map(item => [item.id, item] as const)));
  const groups: CommandMenuGroup[] = menu.groups.map(group => ({ title: group.title, options: group.items.map(item => ({
    id: item.id, label: item.title, ranges: item.ranges, sub: item.sub, icon: item.icon, pill: item.pill,
    leading: item.agent ? <AgentMark agent={item.agent} size={20} labelled={false} /> : undefined,
    keys: item.command?.keys ? keyCaps(item.command.keys) : undefined,
  })) }));
  // A file a running task changed opens that task; any other file has no viewer route yet, so Enter copies its repo-relative path.
  const [activeId, setActiveId] = useState<string>();
  const active = activeId ? byId.get(activeId) : undefined;
  const notifications = useNotifications();
  const copyPath = (path: string) => {
    const done = (ok: boolean) => notifications?.notify(ok ? { key: "copy-path", tone: "success", title: "Path copied", message: path } : { key: "copy-path", tone: "error", title: "Could not copy the path", message: path });
    try { void navigator.clipboard.writeText(path).then(() => done(true), () => done(false)); } catch { done(false); }
  };
  const pick = (id: string, options?: { keepOpen: boolean }) => {
    const item = byId.get(id);
    if (!item) return;
    if (item.copy !== undefined) { if (!options?.keepOpen) { copyPath(item.copy); close(); } return; }
    // ⌘↵ runs a command and leaves the menu open so several can run in a row, except one that opens its own dialog.
    if (options?.keepOpen && !item.command?.opensDialog) { if (item.command) setTimeout(item.command.run, 0); return; }
    close();
    rememberRecent(item.id, recent);
    // After the menu has closed, so a command that opens a dialog starts from the restored focus.
    if (item.command) setTimeout(item.command.run, 0);
    else if (item.target) navigate(item.target);
  };
  const searching = menu.mode === "search";
  return <CommandMenu label="Search tasks, agents or run a command" placeholder="Search tasks, agents or type > for commands"
    query={text} onQueryChange={edit} onBackspaceEmpty={commandMode ? () => setCommandMode(false) : undefined} prefix={menu.mode === "commands" ? "Commands" : menu.mode === "ask" ? "Ask" : undefined}
    scopes={searching ? scopesFor(filesOn).map(item => ({ ...item, count: menu.counts[item.id] })) : undefined} scope={menu.scope} onScope={id => setScope(id as MenuScope)}
    groups={groups} empty={menu.empty ? { title: `Nothing matches “${text.trim()}”`, description: "Try fewer words, another scope, or turn it into work:" } : undefined}
    enterHint={active?.copy !== undefined ? "copy path" : menu.enterHint} onActiveChange={setActiveId} notice={menu.notice} modEnterHint={menu.modEnterHint} modEnterSoon={menu.modEnterSoon} modEnterKeys={keyCaps("Mod-Enter")} hints={<span className="pc-command__hint"><Kbd>&gt;</Kbd> commands{ASK_ENABLED && <> · <Kbd>?</Kbd> ask assistant</>}</span>}
    onPick={pick} onClose={close} returnFocus={returnFocus} />;
}
