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
import { draftStorage } from "../model/draft";
import { blankNewTask, NEW_TASK_DRAFT_KEY } from "../model/new-task";

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

/** Copies text with the clipboard API, falling back to selecting a hidden element where a webview refuses it. Resolves whether anything was copied. */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* try the older way */ }
  // A modal menu still open would leave the page inert, and inert text cannot be selected: let it close first.
  await new Promise(resolve => setTimeout(resolve, 60));
  try {
    const holder = document.createElement("span");
    holder.className = "sr-only";
    holder.textContent = text;
    document.body.appendChild(holder);
    const selection = window.getSelection(), range = document.createRange();
    range.selectNodeContents(holder);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const ok = document.execCommand("copy");
    selection?.removeAllRanges();
    holder.remove();
    return ok;
  } catch { return false; }
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
  const { navigate, current } = useNavigation();
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
  const menu = useMemo(() => {
    return buildMenu({ query, scope, snapshot, commands, recent, now, files });
  }, [query, scope, snapshot, commands, recent, now, files.status, (files as { result?: unknown }).result]);
  const visibleGroups = menu.mode === "recent" && scope !== "all"
    ? menu.groups.map(group => ({ ...group, items: group.items.filter(item => item.scope === scope) })).filter(group => group.items.length)
    : [...menu.groups];
  const switchScope = (id: string) => {
    setCommandMode(id === "commands");
    setScope(id === "commands" ? "all" : id as MenuScope);
  };
  const empty = menu.empty;
  const start = commands.find(command => command.id === "task.new" && !command.hidden);
  if (empty && !visibleGroups.some(group => group.items.some(item => item.command?.id === "task.new")) && start) {
    visibleGroups.push({ title: "Instead", items: [{ id: "command:task.new", scope: "commands", title: "New task", icon: "plus", command: start }] });
  }
  const byId = new Map<string, MenuItem>(visibleGroups.flatMap(group => group.items.map(item => [item.id, item] as const)));
  const groups: CommandMenuGroup[] = visibleGroups.map(group => ({ title: group.title, options: group.items.map(item => ({
    id: item.id, label: empty && item.command?.id === "task.new" ? `New task: “${text.trim()}”` : item.title, ranges: item.ranges, sub: empty && item.command?.id === "task.new" ? undefined : item.sub, icon: item.icon, pill: item.pill,
    leading: item.agent ? <AgentMark agent={item.agent} size={20} labelled={false} /> : undefined,
    keys: item.command?.keys ? keyCaps(item.command.keys) : undefined,
  })) }));
  // A file a running task changed opens that task; any other file has no viewer route yet, so Enter copies its repo-relative path.
  const [activeId, setActiveId] = useState<string>();
  const active = (activeId ? byId.get(activeId) : undefined) ?? visibleGroups[0]?.items[0];
  const notifications = useNotifications();
  const copyPath = (path: string) => {
    const done = (ok: boolean) => notifications?.notify(ok ? { key: "copy-path", tone: "success", title: "Path copied", message: path } : { key: "copy-path", tone: "error", title: "Could not copy the path", message: path });
    void copyText(path).then(done);
  };
  const pick = (id: string, options?: { keepOpen: boolean }) => {
    const item = byId.get(id);
    if (!item) return;
    if (empty && item.command?.id === "task.new") {
      const storage = draftStorage(NEW_TASK_DRAFT_KEY, blankNewTask, {
        getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key),
      });
      const draft = storage.read();
      if (current.name === "new-task") {
        // Use the mounted composer's input handler so its state and saved draft stay in sync.
        const input = document.getElementById("nt-request");
        if (input instanceof HTMLTextAreaElement && !draft.request.trim() && !input.value.trim()) {
          input.value = text.trim();
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        close();
        return;
      }
      if (!draft.request.trim()) storage.write({ ...draft, request: text.trim() });
    }
    if (item.copy !== undefined) { if (!options?.keepOpen) { copyPath(item.copy); close(); } return; }
    // ⌘↵ runs a command and leaves the menu open so several can run in a row, except one that opens its own dialog.
    if (options?.keepOpen && !item.command?.opensDialog) { if (item.command) setTimeout(item.command.run, 0); return; }
    close();
    rememberRecent(item.id, recent);
    // After the menu has closed, so a command that opens a dialog starts from the restored focus.
    if (item.command) setTimeout(item.command.run, 0);
    else if (item.target) navigate(item.target);
  };
  const keepOpen = active?.command && !active.command.opensDialog ? "run and keep open" : undefined;
  return <CommandMenu label={filesOn ? "Search tasks, agents, files or run a command" : "Search tasks, agents or run a command"} placeholder={filesOn ? "Search tasks, agents, files or type > for commands" : "Search tasks, agents or type > for commands"}
    query={text} onQueryChange={edit} onBackspaceEmpty={commandMode ? () => setCommandMode(false) : undefined} prefix={menu.mode === "commands" ? "Commands" : menu.mode === "ask" ? "Ask" : undefined}
    scopes={scopesFor(filesOn).map(item => ({ ...item, count: item.id === "files" && files.status === "loading" ? undefined : menu.mode === "search" ? menu.counts[item.id] : undefined }))} scope={commandMode ? "commands" : menu.mode === "search" ? menu.scope : scope} onScope={switchScope}
    groups={groups} empty={empty ? { title: `Nothing matches “${text.trim()}”`, description: "Try fewer words, another scope, or turn it into work:" } : undefined}
    enterHint={active?.copy !== undefined ? "copy path" : empty && active?.command?.id === "task.new" ? "run" : menu.enterHint} onActiveChange={setActiveId} notice={menu.notice} modEnterHint={keepOpen} modEnterKeys={keyCaps("Mod-Enter")} hints={<span className="pc-command__hint"><Kbd>&gt;</Kbd> commands{ASK_ENABLED && <> · <Kbd>?</Kbd> ask assistant</>}</span>}
    onPick={pick} onClose={close} returnFocus={returnFocus} />;
}
