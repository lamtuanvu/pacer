import { counts as snapshotCounts } from "../../../src/view-model/selectors";
import { DensityContext } from '../ds/Density';
import { LoadingState } from "../ds/Patterns";
import { SectionHeading } from "../ds/SectionHeading";
import type { ComponentChildren } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Mark } from "../ds/Mark";
import type { StoreState } from "../data/store";
import type { Route } from "../router";
import { AppLink } from "../navigation";
import { routes } from "../router";
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
import { TopBar } from "./TopBar";
import { StatusBar } from "./StatusBar";
import { commands, keys } from "../keys/instance";
import { SidePanel } from "../ds/SidePanel";
import { AppFrame } from "./AppFrame";
import { panelCommands, usePanelState } from "./panels";
import { FrameContext, type FrameHeading } from "./slots";
import { DOCK_ID, TerminalDock } from "./TerminalDock";

const SETTINGS = new Set(["settings", "hosts", "add-executor"]);
const NEEDS_READ_MODEL = new Set(["dispatch", "review"]);
function Skeleton() {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSlow(true), 1000); return () => clearTimeout(t); }, []);
  if (slow) return <LoadingState label="Connecting to pacer…"/>;
  return <div className="pc-skeleton" aria-hidden="true">{[0, 1, 2].map(i => <div key={i} className="pc-skeleton__section"><span /><span /><span /></div>)}</div>;
}
/** Compact desktop header and rail; narrow screens keep touch navigation. AppFrame owns the regions. */
export function Layout({ route, state, title, onDelegate = () => {}, children }: { route: Route; state: StoreState; title: string; onDelegate?: () => void; children: ComponentChildren }) {
  const narrow = useNarrow(route.query);
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
  const taskPanels = !narrow && wide && route.name === "sessions" && !!route.id && !!context && !state.sessionEnded;
  // Both panels start open only where the session keeps room beside them; a saved choice always wins.
  const roomy = typeof matchMedia === "function" && matchMedia("(min-width: 1100px)").matches;
  const [tasksOpen, setTasksOpen] = usePanelState("tasks", roomy);
  const [detailsOpen, setDetailsOpen] = usePanelState("session-details", roomy);
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null), [leftSlot, setLeftSlot] = useState<HTMLElement | null>(null);
  const [rightSlot, setRightSlot] = useState<HTMLElement | null>(null), [heading, setHeading] = useState<FrameHeading | null>(null);
  const slots = useMemo(() => ({ title: titleSlot, actions: actionSlot, left: leftSlot, right: rightSlot, inline: !taskPanels, heading: setHeading,
    sessions: taskPanels ? { open: tasksOpen, toggle: () => setTasksOpen(!tasksOpen) } : undefined,
    details: taskPanels ? { open: detailsOpen, toggle: () => setDetailsOpen(!detailsOpen) } : undefined }), [titleSlot, actionSlot, leftSlot, rightSlot, taskPanels, tasksOpen, detailsOpen]);
  // One terminal screen at a time, and only where the full desktop frame (and a service connection) exists.
  const dockAvailable = showStatusBar && wide && !!context && route.name !== "terminal" && !state.sessionEnded;
  const toggleDock = () => {
    const here = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    // Opening remembers the opener; closing from outside the dock keeps focus where it is.
    if (!dockOpen || (here && !here.closest(".pc-dock"))) opener.current = here;
    setDockOpen(!dockOpen);
  };
  useEffect(() => {
    const offs = panelCommands(hasLeft ? () => setLeftOpen(!leftOpen) : taskPanels ? () => setTasksOpen(!tasksOpen) : undefined,
      dockAvailable ? toggleDock : undefined, taskPanels ? () => setDetailsOpen(!detailsOpen) : undefined).map(command => commands.register(command));
    return () => offs.forEach(off => off());
  }, [hasLeft, leftOpen, taskPanels, tasksOpen, detailsOpen, dockAvailable, dockOpen]);
  // Dispatcher commands exist only where the service offers the operation (UI-13).
  const paused = !!state.snapshot?.pause, ops = state.features.ops, api = context?.api;
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
      ...(ops.has(paused ? "delegation.resume" : "delegation.pause") ? [commands.register(paused
        ? { id: "dispatch.resume", title: "Resume dispatch", sub: "New tasks start again", group: "Dispatcher", icon: "dispatch", keywords: "unpause continue", run: () => { void api.call("delegation.resume", {}).catch(fail); } }
        : { id: "dispatch.pause", title: "Pause dispatch", sub: "Running tasks finish; nothing new starts", group: "Dispatcher", icon: "dispatch", keywords: "stop hold", run: () => { void api.call("delegation.pause", { for: "1h" }).catch(fail); } })] : []),
      ...(ops.has("strategy.use") ? [commands.register({ id: "dispatch.setup", opensDialog: true, title: "Switch saved setup…", sub: activeSetup ? `Active: ${activeSetup}` : undefined, group: "Dispatcher", icon: "routing", keywords: "strategy routing profile", run: () => setSetupOpen(true) })] : []),
      commands.register({ id: "dispatch.budget", title: "Budget & pacing", sub: pacing, group: "Dispatcher", icon: "gauge", keywords: "planner quota limit", run: () => navigate(routes.settings("planner")) }),
    ];
    return () => offs.forEach(off => off());
  }, [api, paused, ops, !state.snapshot, notifications, activeSetup, pacing]);
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
  if (state.sessionEnded) return <main className="session-ended"><Mark /><h1>Session ended.</h1><p>Run <code>pacer open</code>.</p></main>;
  const counts = state.snapshot ? snapshotCounts(state.snapshot) : null;
  const loading = route.name === "loading" || !state.snapshot;
  const outdated = !loading && NEEDS_READ_MODEL.has(route.name) && !state.features.readModel;
  const topBar = <TopBar narrow={narrow} title={title} planner={state.snapshot?.planner ?? null} mode={state.snapshot?.mode?.mode ?? ""} connected={state.connected} lastUpdate={state.snapshot?.at ?? null} onDelegate={onDelegate} delegate={route.name !== "dispatch"} pageTitle={route.name !== "dispatch" && route.name !== "review" && route.name !== "plugin" && !(route.name === "settings" && (route.section === "plugins" || !!route.section?.startsWith("plugins/")))} plannerFigure={route.name !== "dispatch"} search={searchable ? <CommandTrigger onOpen={togglePalette} /> : undefined} narrowSearch={searchable ? <CommandTrigger narrow onOpen={togglePalette} /> : undefined} brand={<AppLink className="pc-topbar__home" to={routes.dispatch()} query={route.query} aria-label="pacer home"><Mark size={18} wordmark={false} /></AppLink>} panels={{ ...(hasLeft ? { left: { open: leftOpen, toggle: () => setLeftOpen(!leftOpen) } } : taskPanels ? { left: { open: tasksOpen, toggle: () => setTasksOpen(!tasksOpen) } } : {}),
      ...(dockAvailable ? { dock: { open: dockOpen, toggle: toggleDock } } : {}), ...(taskPanels ? { right: { open: detailsOpen, toggle: () => setDetailsOpen(!detailsOpen), label: "details panel", keys: "Control+Shift+B" } } : {}) }}
    heading={heading} context={setTitleSlot} actions={setActionSlot} showActions={route.name !== "setup"} />;
  const settings = SETTINGS.has(route.name) && (hasLeft
    ? <SidePanel side="left" label="Settings" open={leftOpen} onToggle={setLeftOpen}><Panel route={route} counts={counts} snapshot={state.snapshot} embedded /></SidePanel>
    : <Panel route={route} counts={counts} snapshot={state.snapshot} />);
  const tasks = taskPanels && <SidePanel side="left" label="Sessions" wide bar={false} contentToggle open={tasksOpen} onToggle={setTasksOpen}><div ref={setLeftSlot} className="pc-frame-slot" /></SidePanel>;
  const details = taskPanels && <SidePanel side="right" label="Session details" open={detailsOpen} onToggle={setDetailsOpen} bar={false}><div ref={setRightSlot} className="pc-frame-slot" /></SidePanel>;
  return <NarrowContext.Provider value={narrow}><FrameContext.Provider value={slots}><AppFrame narrow={narrow}
    top={narrow && route.name === "setup" ? null : topBar}
    activity={<Rail route={route} counts={counts} narrow={narrow} settingsAttention={settingsAttention(state.snapshot)} />}
    left={settings || tasks}
    right={details}
    live={!state.connected && state.snapshot && <div className="connection-bar">pacer isn't responding. Retrying…</div>}
    mainClass={`pc-main${!loading && !outdated && ["dispatch","review","settings","hosts","add-executor","sessions","terminal","setup"].includes(route.name)?" pc-main--canvas":""}`}
    main={loading ? <Skeleton /> : outdated ? <section className="pc-notice"><SectionHeading>Update pacer to use this view</SectionHeading><p>This screen needs a newer pacer service. Run <code>pacer update</code>, then reload this page.</p></section> : <DensityContext.Provider value={SETTINGS.has(route.name) ? "settings" : "compact"}>{children}</DensityContext.Provider>}
    dock={dockAvailable && dockOpen && <TerminalDock query={route.query} close={toggleDock} />}
    status={showStatusBar && <StatusBar route={route} snapshot={state.snapshot} registry={keys} terminal={dockAvailable ? { open: dockOpen, toggle: toggleDock } : undefined} />}
  />{setupOpen && <StrategyQuickAccessPopup route={route} close={() => setSetupOpen(false)} />}{palette && Palette && <Palette snapshot={state.snapshot} returnFocus={() => paletteReturn.current} close={() => setPalette(false)} />}</FrameContext.Provider></NarrowContext.Provider>;
}
