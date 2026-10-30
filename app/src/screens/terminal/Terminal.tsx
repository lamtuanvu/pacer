import type { RouteQuery } from "../../router";
import type { TerminalRecord } from "../../../../src/terminal/workspace";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button, IconButton } from "../../ds/Button";
import { activeRepo } from "../../shell/narrow";
import { Icon } from "../../ds/icons";
import type { TerminalActions } from "../../term/term";
import { Field, TextInput } from "../../ds/Controls";
import { Dialog } from "../../ds/Dialog";
import { EmptyState, LoadingState } from "../../ds/Patterns";
import { Page } from "../../ds/Page";
import { useDialogs } from "../../ds/useDialogs";
import { ApiError } from "../../data/api";
import { useNavigation } from "../../navigation";
import { routes } from "../../router";
import { LazyTerminal } from "../../term/LazyTerminal";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { pendingAfterFailure, terminalRequest, type TerminalRequest } from "./request";
import { ReopenToUpdate } from "../session/ReopenToUpdate";

/** `embedded` renders inside the terminal dock: no page gutters, and tab choice stays local instead of changing the route. */
export function TerminalScreen({ id: routeId, query, embedded = false, folder, closePanel, maximize, maximized = false }: { id?: string; query: RouteQuery; embedded?: boolean; folder?: string; closePanel?: () => void; maximize?: () => void; maximized?: boolean }) {
  const { api, state } = useTaskContext();
  const navigation = useNavigation();
  const dialogs = useDialogs();
  const [tabs, setTabs] = useState<TerminalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [loadError, setLoadError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [cwd, setCwd] = useState("");
  const [menu, setMenu] = useState<"new" | "more" | null>(null);
  const [chooseFolder, setChooseFolder] = useState(false);
  const [ratio, setRatio] = useState(1);
  const actions = useRef(new Map<string, TerminalActions>());
  const header = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const [locked, setLocked] = useState<Record<string, boolean>>({});
  const [splitId, setSplitId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const pendingRequest = useRef<TerminalRequest | null>(null);
  const cancelRename = useRef(false);
  const [localId, setLocalId] = useState<string>();
  const id = embedded ? localId : routeId;
  const show = (tabId?: string) => embedded ? setLocalId(tabId) : navigation.navigate(routes.terminal(tabId));
  const available = state.features.ops.has("terminal.create");
  const repos = state.snapshot?.repos ?? [];
  const folderLabel = (path: string) => {
    const repo = repos.filter(repo => path.startsWith(`${repo.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
    return repo ? `${repo.label}/${path.slice(repo.path.length + 1)}` : path.split("/").filter(Boolean).at(-1);
  };
  const selected = tabs.find(tab => tab.id === id) ?? tabs.at(-1);
  const secondary = tabs.find(tab => tab.id === splitId && tab.id !== selected?.id);


  useEffect(() => {
    if (!available) { setLoading(false); return; }
    let active = true;
    const refresh = async () => {
      try {
        const result = await api.call<TerminalRecord[]>("terminal.list", {});
        if (active) { setTabs(result); setLoadError(undefined); setLoading(false); }
      } catch (failure) { if (active) { setLoadError(failure); setLoading(false); } }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => { active = false; clearInterval(timer); };
  }, [api, available, state.connected]);

  useEffect(() => { if (splitId && !tabs.some(tab => tab.id === splitId)) setSplitId(null); }, [tabs, splitId]);

  const open = async (directory = folder ?? repos.find(repo => repo.key === activeRepo(query))?.path ?? selected?.cwd ?? "", splitAfter = false) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      const request = terminalRequest(pendingRequest.current, directory.trim(), () => crypto.randomUUID());
      pendingRequest.current = request;
      const created = await api.call<TerminalRecord>("terminal.create", {
        request_id: request.id, kind: "shell", ...(request.cwd ? { cwd: request.cwd } : {}),
      });
      pendingRequest.current = null;
      setTabs(previous => [...previous.filter(tab => tab.id !== created.id), created]);
      if (splitAfter && selected) { show(selected.id); setSplitId(created.id); } else show(created.id);
      setMenu(null); setChooseFolder(false);
      return created;
    } catch (failure) { pendingRequest.current=pendingAfterFailure(pendingRequest.current,failure instanceof ApiError?failure.status:undefined);setError(failure); }
    finally { setBusy(false); }
  };

  const rename = async () => {
    if (!selected || !newTitle.trim() || busy) return;
    setBusy(true); setError(undefined);
    try {
      const next = await api.call<TerminalRecord>("terminal.rename", { id: selected.id, title: newTitle.trim(), expect_rev: selected.rev });
      setTabs(previous => previous.map(tab => tab.id === next.id ? next : tab));
      setRenaming(false);
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };

  const close = async (tab: TerminalRecord) => {
    if (busy || tab.exit === null && !await dialogs.confirm(`Stop ${tab.title} and close its tab?`, "Close terminal", "Stop and close")) return;
    setBusy(true); setError(undefined);
    try {
      await api.call("terminal.close", { id: tab.id, expect_rev: tab.rev });
      const remaining = tabs.filter(item => item.id !== tab.id);
      setTabs(remaining);
      if (splitId === tab.id) setSplitId(null);
      if (selected?.id === tab.id) show(remaining.at(-1)?.id);
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };

  const split = () => {
    if (!selected) return;
    if (secondary) { setSplitId(null); return; }
    void open(selected.cwd, true);
  };
  const startRename = (tab = selected) => { if (!tab) return; show(tab.id); cancelRename.current = false; setNewTitle(tab.title); setRenaming(true); setMenu(null); };
  const command = (name: "find" | "clear" | "reader") => { if (selected) actions.current.get(selected.id)?.[name](); setMenu(null); };
  useEffect(() => {
    if (!menu) return;
    menuTrigger.current = document.activeElement as HTMLElement;
    header.current?.querySelector<HTMLButtonElement>('[role="menu"] button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!header.current?.contains(event.target as Node)) setMenu(null); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);
  const closeMenu = () => { setMenu(null); menuTrigger.current?.focus(); };
  const pane = (tab: TerminalRecord, first = false) => <div key={tab.id} className="pc-workspace-terminal__pane" style={{ flexGrow: first && secondary ? ratio : 1 }} role="region" aria-label={`Terminal: ${tab.title}`}>
    {tab.live && <ReopenToUpdate host={tab.hostVersion} />}
    <LazyTerminal key={tab.id} id={tab.id} url={tab.attach.ws} label="pacer terminal" cols={tab.cols} rows={tab.rows} control resize live={tab.live} shell
      onActions={controls => { if (controls) actions.current.set(tab.id, controls); else actions.current.delete(tab.id); setReady(previous => previous[tab.id] === !!controls ? previous : { ...previous, [tab.id]: !!controls }); }}
      onInputLocked={value => setLocked(previous => previous[tab.id] === value ? previous : { ...previous, [tab.id]: value })} />
  </div>;
  const tool = (label: string, icon: Parameters<typeof Icon>[0]["name"], run: () => void, disabled = false, reason?: string) => <IconButton className="pc-terminal-tool" size="sm" variant="quiet" icon={icon} aria-label={label} title={disabled ? reason ?? "Open a terminal first" : label} disabled={disabled} onClick={run} />;

  if (!available) return <Page width="full" embedded={embedded}><EmptyState title="Built-in terminal needs a newer Pacer service." description="Update Pacer, then reload this page." /></Page>;
  return <Page width="full" embedded={embedded} className="pc-workspace-terminal" onKeyDownCapture={event => {
    if ((event.metaKey || event.ctrlKey) && (event.key === "\\" || event.key.toLowerCase() === "f" && !(event.target as HTMLElement).closest(".pc-terminal-view"))) { event.preventDefault(); event.stopPropagation(); if (event.key.toLowerCase() === "f") command("find"); else split(); }
    if (event.key === "Escape") setMenu(null);
  }}>
    {!embedded && <h1>Terminal</h1>}
    {dialogs.dialog}
    <div ref={header} className="pc-workspace-terminal__header" onKeyDown={event => {
      if (!menu) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
      if (event.key === "Tab") { setMenu(null); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(header.current!.querySelectorAll<HTMLButtonElement>('[role="menu"] button:not(:disabled)'));
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }}>
      <nav className="pc-workspace-terminal__tabs" role="tablist" aria-label="Terminals">
        {tabs.map(tab => <div className="pc-workspace-terminal__tab" key={tab.id}>
          {renaming && selected?.id === tab.id ? <form onSubmit={event => { event.preventDefault(); void rename(); }}><TextInput aria-label="Terminal name" autoFocus value={newTitle} maxLength={80} onInput={event => setNewTitle(event.currentTarget.value)} onBlur={() => { if (!cancelRename.current && newTitle.trim()) void rename(); else setRenaming(false); }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancelRename.current = true; setRenaming(false); } }} /></form> : <Button role="tab" id={`terminal-${tab.id}-tab`} size="sm" variant="quiet" aria-selected={selected?.id === tab.id} tabIndex={selected?.id === tab.id ? 0 : -1} onClick={() => show(tab.id)} onDblClick={() => startRename(tab)} onKeyDown={event => {
            const at = tabs.findIndex(item => item.id === tab.id);
            const next = event.key === "ArrowRight" ? tabs[(at + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(at + tabs.length - 1) % tabs.length] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : null;
            if (next) { event.preventDefault(); show(next.id); document.getElementById(`terminal-${next.id}-tab`)?.focus(); }
          }} title={`${tab.cwd} · double-click to rename${locked[tab.id] ? " · Only one window can type into this shell at a time" : ""}`}><Icon name="terminal" />{tab.title}{!tab.live && tab.exit !== null ? ` · exited ${tab.exit}` : ""}</Button>}
          {selected?.id === tab.id && <IconButton className="pc-terminal-tab-kill" size="sm" variant="quiet" aria-label={`Kill ${tab.title}`} title="Kill terminal" onClick={() => void close(tab)}>×</IconButton>}
        </div>)}
      </nav>
      <div className="pc-terminal-menu-anchor">
        {tool("New terminal", "plus", () => { void open(); }, busy)}
        <IconButton className="pc-terminal-tool pc-terminal-chevron" size="sm" variant="quiet" aria-label="New terminal in…" title="New terminal in a repository, worktree or folder" aria-expanded={menu === "new"} aria-haspopup="menu" onClick={() => setMenu(menu === "new" ? null : "new")}><Icon name="chevron-down" /></IconButton>
        {menu === "new" && <div className="pc-terminal-menu" role="menu" >
          {repos.map(repo => <Button role="menuitem" variant="quiet" key={repo.key} title={repo.path} onClick={() => void open(repo.path)}>{repo.label}</Button>)}
          {[...new Set(state.snapshot?.tasks?.map(task => task.worktree).filter((path): path is string => !!path) ?? [])].map(path => <Button role="menuitem" variant="quiet" key={path} title={path} onClick={() => void open(path)}>{folderLabel(path)}</Button>)}
          <Button role="menuitem" variant="quiet" onClick={() => void open("")}>Home folder</Button>
          <Button role="menuitem" variant="quiet" onClick={() => { setMenu(null); setCwd(""); setChooseFolder(true); }}>Choose a folder…</Button>
        </div>}
      </div>
      <span className="grow" />
      {tool("Find (⌘F)", "search", () => command("find"), !selected || !ready[selected.id], selected ? "Terminal is loading" : undefined)}
      {tool("Split terminal (⌘\\)", "panel-right", split, !selected || busy)}
      {tool("Kill terminal", "end-session", () => { if (selected) void close(selected); }, !selected || busy)}
      <div className="pc-terminal-menu-anchor">
        <IconButton className="pc-terminal-tool" size="sm" variant="quiet" icon="more" aria-label="More terminal actions" title="More terminal actions" aria-haspopup="menu" aria-expanded={menu === "more"} onClick={() => setMenu(menu === "more" ? null : "more")}/>
        {menu === "more" && <div className="pc-terminal-menu" role="menu">
          <Button role="menuitem" variant="quiet" disabled={!selected} title={!selected ? "Open a terminal first" : undefined} onClick={() => startRename()}>Rename</Button>
          <Button role="menuitem" variant="quiet" disabled title="This service does not offer opening workspace shells in an external terminal">Open in external terminal</Button>
          <Button role="menuitem" variant="quiet" disabled={!selected || !ready[selected.id]} title={!selected ? "Open a terminal first" : !ready[selected.id] ? "Terminal is loading" : undefined} onClick={() => command("reader")}>Screen reader mode</Button>
          <Button role="menuitem" variant="quiet" disabled={!selected || !ready[selected.id]} title={!selected ? "Open a terminal first" : !ready[selected.id] ? "Terminal is loading" : undefined} onClick={() => command("clear")}>Clear</Button>
        </div>}
      </div>
      <span className="pc-terminal-divider" />
      {<IconButton className={`pc-terminal-tool${maximized ? "" : " pc-terminal-maximize"}`} variant="quiet" size="sm" aria-label={maximized ? "Restore panel" : "Maximize panel"} disabled={!maximize} title={!maximize ? "Terminal already fills the work area" : maximized ? "Restore panel" : "Maximize panel"} onClick={maximize}><Icon name="chevron-down" /></IconButton>}
      {<IconButton className="pc-terminal-tool" variant="quiet" size="sm" aria-label="Hide panel (Ctrl+`)" aria-keyshortcuts="Control+`" title="Hide panel (Ctrl+`)" onClick={closePanel ?? (() => navigation.navigate(routes.dispatch()))}><Icon name="close" /></IconButton>}
    </div>
    <ErrorMessage error={error ?? loadError} />
    {loading ? <LoadingState label="Loading terminals…" /> : !selected ? <EmptyState title="No terminals open" description="Use + to start a shell in the current repository, or choose a folder from the menu." /> : <div className="pc-workspace-terminal__panes">
      {pane(selected, true)}
      {secondary && <><div className="pc-terminal-split-sash" role="separator" aria-label="Resize terminal split" aria-orientation="vertical" aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(ratio / (1 + ratio) * 100)} tabIndex={0}
        onKeyDown={event => { const pct = ratio / (1 + ratio); const next = event.key === "ArrowLeft" ? pct - .05 : event.key === "ArrowRight" ? pct + .05 : event.key === "Home" ? .2 : event.key === "End" ? .8 : null; if (next !== null) { event.preventDefault(); const p = Math.max(.2, Math.min(.8, next)); setRatio(p / (1 - p)); } }}
        onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const box = event.currentTarget.parentElement!.getBoundingClientRect(); const p = Math.max(.2, Math.min(.8, (event.clientX - box.left) / box.width)); setRatio(p / (1 - p)); }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />{pane(secondary)}</>}
    </div>}
    {chooseFolder && <Dialog title="Choose a folder" close={() => setChooseFolder(false)}><form className="pc-form" onSubmit={event => { event.preventDefault(); void open(cwd); }}><Field label="Folder path"><TextInput autoFocus required value={cwd} placeholder="Absolute path" onInput={event => setCwd(event.currentTarget.value)} /></Field><Button type="submit" busy={busy}>Open terminal</Button></form></Dialog>}
  </Page>;
}
