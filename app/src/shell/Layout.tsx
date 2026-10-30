import { isMacPlatform } from "../keys/commands";
import { applyDensity, savedDensity, DENSITY_KEY } from "../density";
import { counts as snapshotCounts } from "../../../src/view-model/selectors";
import { DensityContext, DensityProvider } from '../ds/Density';
import { Skeleton } from "../ds/Patterns";
import { SectionHeading } from "../ds/SectionHeading";
import type { ComponentChildren } from "preact";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { Mark } from "../ds/Mark";
import type { StoreState } from "../data/store";
import type { Route } from "../router";
import { AppLink } from "../navigation";
import { pageOwnsTitle, routes } from "../router";
import { Rail, settingsAttention } from "./Rail";
import { TaskContext } from "../screens/task-shared";
import { SettingsPanel, SettingsPanelData } from "./SettingsPanel";
import { NarrowContext, PANEL_MEDIA, useMedia, useNarrow } from "./narrow";
import { agentInfo } from "../../../src/view-model/agents";
import { modeWords } from "../../../src/view-model/words";
import { CommandTrigger } from "./CommandTrigger";
import { StrategyQuickAccessPopup } from "./StrategyQuickAccess";
import { useNotifications } from "../data/notification-context";
import { useNavigation } from "../navigation";
import { OfflineNotice } from "./OfflineNotice";
import { TopBar } from "./TopBar";
import { StatusBar } from "./StatusBar";
import { commands, keys } from "../keys/instance";
import { SidePanel } from "../ds/SidePanel";
import { AppFrame } from "./AppFrame";
import { panelCommands, usePanelState } from "./panels";
import { FrameContext, type FrameHeading } from "./slots";
import { DOCK_ID, TerminalDock } from "./TerminalDock";
import { useAgentDeepLink } from "./panels/agent-link";
import { activeRepo } from "./narrow";

/** The sheet loads after first paint so it stays out of the main bundle. Older services never load it. */
function AssistantLoader(props: { route: Route; narrow: boolean; repo: string | null; repoLabel: string | null; onNewTask: () => void }) {
  const [View, setView] = useState<typeof import("./assistant/AssistantHost").default>();
  useEffect(() => { void import("./assistant/AssistantHost").then(m => setView(() => m.default), () => undefined); }, []);
  return View ? <View {...props} /> : null;
}

const SETTINGS = new Set(["settings", "hosts", "add-executor"]);
const NEEDS_READ_MODEL = new Set(["dispatch", "review"]);
/** Compact desktop header and rail; narrow screens keep touch navigation. AppFrame owns the regions. */
export function Layout({ route, loadingRoute = route, state, title, onDelegate = () => {}, children }: { route: Route; loadingRoute?: Route; state: StoreState; title: string; onDelegate?: () => void; children: ComponentChildren }) {
  const narrow = useNarrow(route.query);
  useAgentDeepLink(route);
  const [density, setDensity] = useState(savedDensity);
  useEffect(() => {
    const sync = (event?: Event) => {
      if (event instanceof StorageEvent && event.key !== null && event.key !== DENSITY_KEY) return;
      const value = event instanceof CustomEvent && event.detail === "compact" ? "compact"
        : event instanceof CustomEvent ? "normal" : savedDensity();
      applyDensity(value);
      setDensity(value);
    };
    sync();
    window.addEventListener("pacer:density", sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("pacer:density", sync); window.removeEventListener("storage", sync); };
  }, []);
  const context = useContext(TaskContext), Panel = context ? SettingsPanelData : SettingsPanel;
  const [leftOpen, setLeftOpen] = usePanelState("settings", true);
  const [dockOpen, setDockOpen] = usePanelState("dock", false);
  const opener = useRef<HTMLElement | null>(null);
  const [palette, setPalette] = useState(false), [setupOpen, setSetupOpen] = useState(false);
  const { navigate: navigateTo } = useNavigation(), navigateRef = useRef(navigateTo), navigate: typeof navigateTo = target => navigateRef.current(target), notifications = useNotifications(), [activeSetup, setActiveSetup] = useState<string | null>(null);
  navigateRef.current = navigateTo;
  // The menu is its own chunk; it loads once the shell is up, so opening it is instant but it stays out of app.js.
  const [Palette, setLoaded] = useState<typeof import("./CommandPalette").CommandPalette | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0), wantOpen = useRef(false);
  // A failed chunk load is retried the next time the menu is asked for, and that request opens it once the chunk arrives.
  useEffect(() => {
    void import("./CommandPalette").then(module => {
      setLoaded(() => module.CommandPalette);
      if (wantOpen.current) { wantOpen.current = false; setPalette(true); }
    }, () => { wantOpen.current = false; });
  }, [loadAttempt]);
  // Where focus goes when the menu closes. WebKit (Safari, the desktop shell) does not focus a button on click, so the
  // title-bar button hands itself over; ⌘K returns to whatever had focus, else to that button.
  const paletteReturn = useRef<HTMLElement | null>(null);
  const triggerFor = (trigger?: HTMLElement) => {
    const here = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    paletteReturn.current = trigger ?? here ?? document.querySelector<HTMLElement>("[data-command-trigger]");
  };
  const togglePalette = (trigger?: HTMLElement) => { triggerFor(trigger); if (Palette) setPalette(open => !open); else { wantOpen.current = true; setLoadAttempt(n => n + 1); } };
  const showStatusBar = !narrow && route.name !== "setup";
  // Side panels and the dock show only from 768px, so their shortcuts never toggle something hidden.
  const wide = useMedia(PANEL_MEDIA, true);
  const hasLeft = !narrow && wide && SETTINGS.has(route.name) && !state.sessionEnded;
  // A task's screen fills the Sessions list on the left and its session details on the right.
  const workPanels = !narrow && wide && !!context && !state.sessionEnded && route.name === "dispatch";
  const [scopeOpen, setScopeOpen] = usePanelState(`${route.name}.scope`, route.name !== "dispatch", route.name === "dispatch");
  const [inspectorOpen, setInspectorOpen] = usePanelState(`${route.name}.inspector`, route.name !== "dispatch", route.name === "dispatch");
  const newTaskPanels = !narrow && wide && route.name === "new-task";
  const taskPanels = !narrow && wide && route.name === "terminal" && !!context && !state.sessionEnded;
  // Both panels start open only where the session keeps room beside them; a saved choice always wins.
  const roomy = typeof matchMedia === "function" && matchMedia("(min-width: 1100px)").matches;
  const [tasksOpen, setTasksOpen] = usePanelState("tasks", roomy);
  const [detailsOpen, setDetailsOpen] = usePanelState("session-details", roomy);
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null), [leftSlot, setLeftSlot] = useState<HTMLElement | null>(null);
  const [rightSlot, setRightSlot] = useState<HTMLElement | null>(null), [heading, setHeading] = useState<FrameHeading | null>(null);
  const slots = useMemo(() => ({ title: titleSlot, actions: actionSlot, left: leftSlot, right: rightSlot, inline: !taskPanels && !workPanels, heading: setHeading,
    sessions: workPanels ? { open: scopeOpen, toggle: () => setScopeOpen(!scopeOpen) } : taskPanels ? { open: tasksOpen, toggle: () => setTasksOpen(!tasksOpen) } : undefined,
    details: newTaskPanels ? {open:inspectorOpen,toggle:()=>setInspectorOpen(!inspectorOpen)} : workPanels ? { open: inspectorOpen, toggle: () => setInspectorOpen(!inspectorOpen) } : taskPanels ? { open: detailsOpen, toggle: () => setDetailsOpen(!detailsOpen) } : undefined }), [titleSlot, actionSlot, leftSlot, rightSlot, taskPanels, tasksOpen, detailsOpen, workPanels, scopeOpen, inspectorOpen, newTaskPanels, route.name]);
  // One terminal screen at a time, and only where the full desktop frame (and a service connection) exists.
  const dockAvailable = showStatusBar && wide && !!context && route.name !== "terminal" && !state.sessionEnded;
  const toggleDock = () => {
    const here = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    // Opening remembers the opener; closing from outside the dock keeps focus where it is.
    if (!dockOpen || (here && !here.closest(".pc-dock"))) opener.current = here;
    setDockOpen(!dockOpen);
  };
  useLayoutEffect(() => {
    const offs = panelCommands(workPanels ? () => setScopeOpen(!scopeOpen) : hasLeft ? () => setLeftOpen(!leftOpen) : taskPanels ? () => setTasksOpen(!tasksOpen) : undefined,
      dockAvailable ? toggleDock : undefined, workPanels || newTaskPanels ? () => setInspectorOpen(!inspectorOpen) : taskPanels ? () => setDetailsOpen(!detailsOpen) : undefined).map(command => commands.register(command));
    return () => offs.forEach(off => off());
  }, [hasLeft, leftOpen, taskPanels, tasksOpen, detailsOpen, dockAvailable, dockOpen, workPanels, scopeOpen, inspectorOpen, newTaskPanels, route.name]);
  // Dispatcher commands exist only where the service offers the operation (UI-13).
  const paused = !!state.snapshot?.pause, ops = state.features.ops, api = context?.api;
  // The UI has its own API client, separate from the store's snapshot transport.
  useLayoutEffect(() => { api?.setConnected?.(state.connected); }, [api, state.connected]);
  const planner = state.snapshot?.planner, mode = state.snapshot?.mode?.mode;
  const pacing = planner && mode ? `Settings · ${agentInfo(planner.agent).name} is in ${modeWords(mode)} mode` : "Settings";
  // The active saved setup is read (an existing operation) when the menu opens, so its row can say which one is on.
  useEffect(() => {
    if (!palette || !api || !ops.has("strategy.list")) return;
    let live = true;
    void api.call<{ name: string; active?: boolean }[]>("strategy.list", {}).then(rows => { if (live) setActiveSetup(rows.find(row => row.active)?.name ?? null); }, () => {});
    return () => { live = false; };
  }, [palette, api, ops]);
  useEffect(() => {
    if (!api || !state.snapshot) return;
    const fail = (error: unknown) => notifications?.notify({ key: "dispatch-command", tone: "error", title: "Could not change dispatching", message: error instanceof Error ? error.message : undefined });
    const offs = [
      ...(state.connected && ops.has(paused ? "delegation.resume" : "delegation.pause") ? [commands.register(paused
        ? { id: "dispatch.resume", title: "Resume dispatch", sub: "New tasks start again", group: "Dispatcher", icon: "play", keywords: "unpause continue", run: () => { void api.call("delegation.resume", {}).catch(fail); } }
        : { id: "dispatch.pause", title: "Pause dispatch", sub: "Running tasks finish; nothing new starts", group: "Dispatcher", icon: "command-pause", keywords: "stop hold", run: () => { void api.call("delegation.pause", { for: "1h" }).catch(fail); } })] : []),
      ...(state.connected && ops.has("strategy.use") ? [commands.register({ id: "dispatch.setup", opensDialog: true, title: "Switch saved setup…", sub: activeSetup ? `Active: ${activeSetup}` : undefined, group: "Dispatcher", icon: "command-setup", keywords: "strategy routing profile", run: () => setSetupOpen(true) })] : []),
      commands.register({ id: "dispatch.budget", title: "Budget & pacing", sub: pacing, group: "Dispatcher", icon: "settings", keywords: "planner quota limit", run: () => navigate(routes.settings("planner")) }),
    ];
    return () => offs.forEach(off => off());
  }, [api, paused, ops, !state.snapshot, state.connected, notifications, activeSetup, pacing]);
  const searchable = route.name !== "setup" && route.name !== "loading";
  useEffect(() => {
    if (!searchable) return;
    return commands.register({ id: "search.open", title: "Search", group: "Go to", keys: "Mod-k", hidden: true, run: () => togglePalette() });
  }, [searchable, Palette]);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    if (dockOpen) document.getElementById(DOCK_ID)?.focus();
    else { (opener.current?.isConnected ? opener.current : document.getElementById("main-content"))?.focus(); opener.current = null; }
  }, [dockOpen]);
  const repo = activeRepo(route.query), repoLabel = state.snapshot?.repos?.find(r => r.key === repo)?.label ?? null;
  const assistantAvailable = !!context && route.name !== "setup" && route.name !== "loading" && !state.sessionEnded && state.features.ops.has("assistant.status");
  if (state.sessionEnded) return <main className="session-ended"><Mark /><h1>Session ended.</h1><p>Run <code>pacer open</code>.</p></main>;
  const counts = state.snapshot ? snapshotCounts(state.snapshot) : null;
  const loading = route.name === "loading" || !state.snapshot;
  const outdated = !loading && NEEDS_READ_MODEL.has(route.name) && !state.features.readModel;
  // Dispatcher and the legacy Assistant screen still rely on the shell for their h1.
  const topBar = <TopBar narrow={narrow} title={title} planner={state.snapshot?.planner ?? null} mode={state.snapshot?.mode?.mode ?? ""} connected={state.connected} lastUpdate={state.snapshot?.at ?? null} onDelegate={onDelegate} delegate={route.name !== "dispatch"} pageTitle={narrow && route.name === "dispatch" || route.name !== "new-task" && (route.name !== "sessions" || !!route.id) && route.name !== "terminal" && !pageOwnsTitle(route) && route.name !== "dispatch" && route.name !== "review" && route.name !== "plugin" && (route.name !== "settings" || route.section === "assistant") && route.name !== "add-executor" && (route.name !== "hosts" || (!!route.alias && !!state.snapshot?.hosts?.some(host => host.alias === route.alias)))} plannerFigure={route.name !== "dispatch"} search={searchable ? <CommandTrigger onOpen={togglePalette} /> : undefined} narrowSearch={searchable ? <CommandTrigger narrow onOpen={togglePalette} /> : undefined} brand={<AppLink className="pc-topbar__home" to={routes.dispatch()} query={route.query} aria-label="pacer home"><Mark size={18} wordmark={false} /></AppLink>} panels={{ ...(workPanels ? { left: { open: scopeOpen, toggle: () => setScopeOpen(!scopeOpen) } } : hasLeft ? { left: { open: leftOpen, toggle: () => setLeftOpen(!leftOpen) } } : taskPanels ? { left: { open: tasksOpen, toggle: () => setTasksOpen(!tasksOpen) } } : {}),
      ...(dockAvailable ? { dock: { open: dockOpen, toggle: toggleDock } } : {}), ...(workPanels || newTaskPanels ? { right: { open: inspectorOpen, toggle: () => setInspectorOpen(!inspectorOpen), label: "Inspector", keys: isMacPlatform() ? "Alt+Meta+B" : "Alt+Control+B" } } : taskPanels ? { right: { open: detailsOpen, toggle: () => setDetailsOpen(!detailsOpen), label: "details panel", keys: isMacPlatform() ? "Alt+Meta+B" : "Alt+Control+B" } } : {}) }}
    heading={heading} context={setTitleSlot} actions={setActionSlot} showActions={route.name !== "setup"} />;
  const settings = SETTINGS.has(route.name) && (hasLeft
    ? <SidePanel side="left" label="Settings" bar={false} open={leftOpen} onToggle={setLeftOpen}><Panel route={route} counts={counts} snapshot={state.snapshot} embedded /></SidePanel>
    : <Panel route={route} counts={counts} snapshot={state.snapshot} />);
  const tasks = taskPanels && <SidePanel side="left" label="Workspace" resize={{key:"pacer.workspace.left-width",initial:272,min:200,max:480}} wide bar={false} contentToggle open={tasksOpen} onToggle={setTasksOpen}><div ref={setLeftSlot} className="pc-frame-slot" /></SidePanel>;
  const details = taskPanels && <SidePanel side="right" label="Task" resize={{key:"pacer.workspace.right-width",initial:320,min:260,max:560}} open={detailsOpen} onToggle={setDetailsOpen} bar={false}><div ref={setRightSlot} className="pc-frame-slot" /></SidePanel>;
  return <NarrowContext.Provider value={narrow}><FrameContext.Provider value={slots}><DensityProvider value={density}><AppFrame narrow={narrow}
    top={narrow && route.name === "setup" ? null : topBar}
    activity={<Rail terminal={dockAvailable ? {open:dockOpen,toggle:toggleDock} : undefined} route={route} counts={counts} narrow={narrow} settingsAttention={settingsAttention(state.snapshot)} />}
    left={settings || tasks || (workPanels && scopeOpen && <aside className="pc-side-panel pc-side-panel--left pc-scope-panel" style={{ flexBasis: "calc(var(--size-240) + var(--space-2))", width: "calc(var(--size-240) + var(--space-2))" }} aria-label="Scope"><div id="pc-side-panel-left" ref={setLeftSlot} className="pc-frame-slot" /></aside>)}
    right={details || (workPanels && inspectorOpen && <aside className="pc-side-panel pc-side-panel--right" aria-label="Inspector"><div id="pc-side-panel-right" ref={setRightSlot} className="pc-frame-slot" /></aside>)}
    live={!state.connected && state.snapshot && <OfflineNotice lastUpdate={state.snapshot.at} />}
    mainClass={`pc-main${loading || !outdated && ["task-failure","task-review","new-task","insights","dispatch","review","settings","hosts","add-executor","sessions","terminal","setup"].includes(route.name)?" pc-main--canvas":""}`}
    main={loading ? <Skeleton layout={SETTINGS.has(loadingRoute.name) ? "settings" : ["task-review", "task-failure"].includes(loadingRoute.name) ? "task" : loadingRoute.name === "sessions" ? (loadingRoute.id ? "task" : "list") : loadingRoute.name === "review" ? "list" : "dashboard"} label={loadingRoute.name === "sessions" && loadingRoute.id ? "Loading the task" : `Loading ${loadingRoute.name === "sessions" ? "tasks" : loadingRoute.name === "review" ? "Needs you" : SETTINGS.has(loadingRoute.name) ? "settings" : "Dispatch"}`} /> : outdated ? <section className="pc-notice"><SectionHeading>Update pacer to use this view</SectionHeading><p>This screen needs a newer pacer service. Run <code>pacer update</code>, then reload this page.</p></section> : <DensityContext.Provider value={SETTINGS.has(route.name) ? "settings" : density}>{children}</DensityContext.Provider>}
    overlay={assistantAvailable && <AssistantLoader route={route} narrow={narrow} repo={repo} repoLabel={repoLabel} onNewTask={onDelegate} />}
    dock={dockAvailable && dockOpen && <TerminalDock query={route.query} folder={(route.name === "sessions" && route.id ? state.snapshot?.tasks.find(task => task.id === route.id)?.worktree : undefined) ?? state.snapshot?.repos?.find(item => item.key === repo)?.path} close={toggleDock} />}
    status={showStatusBar && <StatusBar route={route} snapshot={state.snapshot} registry={keys} terminal={dockAvailable ? { open: dockOpen, toggle: toggleDock } : undefined} />}
  /></DensityProvider>{setupOpen && <StrategyQuickAccessPopup route={route} close={() => setSetupOpen(false)} />}{palette && Palette && <Palette snapshot={state.snapshot} returnFocus={() => paletteReturn.current} close={() => setPalette(false)} />}</FrameContext.Provider></NarrowContext.Provider>;
}
