import type { RouteQuery } from "../../router";
import type { TerminalRecord } from "../../../../src/terminal/workspace";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button, IconButton } from "../../ds/Button";
import { ChoicePicker } from "../../ds/ChoicePicker";
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

export function TerminalScreen({ id, query }: { id?: string; query: RouteQuery }) {
  const { api, state } = useTaskContext();
  const navigation = useNavigation();
  const dialogs = useDialogs();
  const [tabs, setTabs] = useState<TerminalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [loadError, setLoadError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [cwd, setCwd] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [splitId, setSplitId] = useState<string | null>(null);
  const [splitDirection, setSplitDirection] = useState<"right" | "down">("right");
  const [renaming, setRenaming] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const pendingRequest = useRef<TerminalRequest | null>(null);
  const available = state.features.ops.has("terminal.create");
  const repos = state.snapshot?.repos ?? [];
  const selected = tabs.find(tab => tab.id === id) ?? tabs.at(-1);
  const secondary = tabs.find(tab => tab.id === splitId && tab.id !== selected?.id);

  useEffect(() => {
    if (workspace || !query.repo) return;
    const repo = repos.find(item => item.key === query.repo);
    if (repo) { setWorkspace(repo.key); setCwd(repo.path); }
  }, [query.repo, repos]);

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

  const open = async () => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      const request = terminalRequest(pendingRequest.current, cwd.trim(), () => crypto.randomUUID());
      pendingRequest.current = request;
      const created = await api.call<TerminalRecord>("terminal.create", {
        request_id: request.id, kind: "shell", ...(request.cwd ? { cwd: request.cwd } : {}),
      });
      pendingRequest.current = null;
      setTabs(previous => [...previous.filter(tab => tab.id !== created.id), created]);
      navigation.navigate(routes.terminal(created.id));
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
      if (selected?.id === tab.id) navigation.navigate(routes.terminal(remaining.at(-1)?.id));
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };

  const split = (direction: "right" | "down") => {
    if (!selected) return;
    const next = tabs.find(tab => tab.id !== selected.id);
    if (!next) return;
    setSplitDirection(direction);
    setSplitId(next.id);
  };

  const pane = (tab: TerminalRecord) => <div key={tab.id} className="pc-workspace-terminal__pane" role="region" aria-label={`Terminal: ${tab.title}`}>
    <div className="pc-workspace-terminal__pane-title"><strong title={tab.title}>{tab.title}</strong><span title={tab.cwd}>{tab.cwd}</span></div>
    <LazyTerminal key={tab.id} id={tab.id} url={tab.attach.ws} label="pacer terminal" cols={tab.cols} rows={tab.rows} control resize live={tab.live} shell />
  </div>;

  if (!available) return <Page width="full"><EmptyState title="Built-in terminal needs a newer Pacer service." description="Update Pacer, then reload this page." /></Page>;
  return <Page width="full" className="pc-workspace-terminal">
    {dialogs.dialog}
    <div className="pc-workspace-terminal__toolbar">
      <Field label="Workspace"><ChoicePicker value={workspace} options={[{ value: "", label: "Home folder" }, ...repos.map(repo => ({ value: repo.key, label: repo.label, description: repo.path }))]} onValueChange={value => { setWorkspace(value); setCwd(repos.find(repo => repo.key === value)?.path ?? ""); }} /></Field>
      <Field label="Working folder"><TextInput value={cwd} placeholder="Home folder or absolute path" onInput={event => { setWorkspace(""); setCwd(event.currentTarget.value); }} /></Field>
      <Button variant="primary" busy={busy} onClick={() => void open()}>New terminal</Button>
    </div>
    <ErrorMessage error={error ?? loadError} />
    {loading ? <LoadingState label="Loading terminals…" /> : tabs.length === 0 ? <EmptyState title="No terminals open" description="Start a shell in your home folder or choose a workspace above." /> : <>
      <nav className="pc-workspace-terminal__tabs" aria-label="Terminals">
        {tabs.map(tab => <div className="pc-workspace-terminal__tab" key={tab.id}>
          <Button id={`terminal-${tab.id}-tab`} size="sm" variant={selected?.id === tab.id ? "secondary" : "quiet"} aria-current={selected?.id === tab.id ? "page" : undefined} onClick={() => navigation.navigate(routes.terminal(tab.id))} onKeyDown={event => {
            const at = tabs.findIndex(item => item.id === tab.id);
            const next = event.key === "ArrowRight" ? tabs[(at + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(at + tabs.length - 1) % tabs.length] : null;
            if (next) { event.preventDefault(); navigation.navigate(routes.terminal(next.id)); document.getElementById(`terminal-${next.id}-tab`)?.focus(); }
          }} title={tab.title}>{tab.title}{!tab.live && tab.exit !== null ? ` · exited ${tab.exit}` : ""}</Button>
          <IconButton size="sm" variant="quiet" aria-label={`Close ${tab.title}`} title={`Close ${tab.title}`} onClick={() => void close(tab)}>×</IconButton>
        </div>)}
      </nav>
      {selected && <>
        <div className="pc-workspace-terminal__actions">
          <Button size="sm" onClick={() => { setNewTitle(selected.title); setRenaming(true); }}>Rename</Button>
          {tabs.length > 1 && !secondary && <><Button size="sm" onClick={() => split("right")}>Split right</Button><Button size="sm" onClick={() => split("down")}>Split down</Button></>}
          {secondary && <><Field label="Second pane"><ChoicePicker value={secondary.id} options={tabs.filter(tab => tab.id !== selected.id).map(tab => ({ value: tab.id, label: tab.title }))} onValueChange={setSplitId} /></Field><Button size="sm" onClick={() => setSplitId(null)}>Close split</Button></>}
        </div>
        <div className={`pc-workspace-terminal__panes${secondary ? ` pc-workspace-terminal__panes--${splitDirection}` : ""}`}>
          {pane(selected)}{secondary && pane(secondary)}
        </div>
      </>}
    </>}
    {renaming && selected && <Dialog title="Rename terminal" close={() => setRenaming(false)}><form className="pc-form" onSubmit={event => { event.preventDefault(); void rename(); }}>
      <Field label="Terminal name"><TextInput autoFocus value={newTitle} maxLength={80} onInput={event => setNewTitle(event.currentTarget.value)} /></Field>
      <div className="row-actions"><Button onClick={() => setRenaming(false)}>Cancel</Button><Button type="submit" variant="primary" busy={busy} disabled={!newTitle.trim()}>Save name</Button></div>
    </form></Dialog>}
  </Page>;
}
