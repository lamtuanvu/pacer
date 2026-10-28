import { counts as snapshotCounts } from "../../../src/view-model/selectors";
import { DensityContext } from '../ds/Density';
import { LoadingState } from "../ds/Patterns";
import { SectionHeading } from "../ds/SectionHeading";
import type { ComponentChildren } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { Mark } from "../ds/Mark";
import type { StoreState } from "../data/store";
import type { Route } from "../router";
import { AppLink } from "../navigation";
import { routes } from "../router";
import { Rail, settingsAttention } from "./Rail";
import { TaskContext } from "../screens/task-shared";
import { SettingsPanel, SettingsPanelData } from "./SettingsPanel";
import { NarrowContext, PANEL_MEDIA, useMedia, useNarrow } from "./narrow";
import { TopBar } from "./TopBar";
import { StatusBar } from "./StatusBar";
import { keys } from "../keys/instance";
import { SidePanel } from "../ds/SidePanel";
import { AppFrame } from "./AppFrame";
import { panelShortcuts, usePanelState } from "./panels";
import { DOCK_ID, TerminalDock } from "./TerminalDock";
import { activeRepo } from "./narrow";

/** The sheet loads after first paint so it stays out of the main bundle. Older services never load it. */
function AssistantLoader(props: { route: Route; narrow: boolean; repo: string | null; repoLabel: string | null; onNewTask: () => void }) {
  const [View, setView] = useState<typeof import("./assistant/AssistantHost").default>();
  useEffect(() => { void import("./assistant/AssistantHost").then(m => setView(() => m.default), () => undefined); }, []);
  return View ? <View {...props} /> : null;
}

const SETTINGS = new Set(["settings", "hosts", "add-executor"]);
const NEEDS_READ_MODEL = new Set(["start", "overview", "review"]);
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
  const showStatusBar = !narrow && route.name !== "setup";
  // Side panels and the dock show only from 768px, so their shortcuts never toggle something hidden.
  const wide = useMedia(PANEL_MEDIA, true);
  const hasLeft = !narrow && wide && SETTINGS.has(route.name) && !state.sessionEnded;
  // One terminal screen at a time, and only where the full desktop frame (and a service connection) exists.
  const dockAvailable = showStatusBar && wide && !!context && route.name !== "terminal" && !state.sessionEnded;
  const toggleDock = () => {
    const here = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    // Opening remembers the opener; closing from outside the dock keeps focus where it is.
    if (!dockOpen || (here && !here.closest(".pc-dock"))) opener.current = here;
    setDockOpen(!dockOpen);
  };
  useEffect(() => {
    const offs = panelShortcuts(hasLeft ? () => setLeftOpen(!leftOpen) : undefined, dockAvailable ? toggleDock : undefined).map(shortcut => keys.register(shortcut));
    return () => offs.forEach(off => off());
  }, [hasLeft, leftOpen, dockAvailable, dockOpen]);
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
  const topBar = <TopBar narrow={narrow} title={title} planner={state.snapshot?.planner ?? null} mode={state.snapshot?.mode?.mode ?? ""} connected={state.connected} lastUpdate={state.snapshot?.at ?? null} onDelegate={onDelegate} brand={<AppLink className="pc-topbar__home" to={routes.overview()} query={route.query} aria-label="pacer home"><Mark size={18} wordmark={false} /></AppLink>} panels={{ ...(hasLeft ? { left: { open: leftOpen, toggle: () => setLeftOpen(!leftOpen) } } : {}), ...(dockAvailable ? { dock: { open: dockOpen, toggle: toggleDock } } : {}) }} showActions={route.name !== "setup"} />;
  const settings = SETTINGS.has(route.name) && (hasLeft
    ? <SidePanel side="left" label="Settings" open={leftOpen} onToggle={setLeftOpen}><Panel route={route} counts={counts} snapshot={state.snapshot} embedded /></SidePanel>
    : <Panel route={route} counts={counts} snapshot={state.snapshot} />);
  return <NarrowContext.Provider value={narrow}><AppFrame narrow={narrow}
    top={narrow && route.name === "setup" ? null : topBar}
    activity={<Rail route={route} counts={counts} narrow={narrow} settingsAttention={settingsAttention(state.snapshot)} />}
    left={settings}
    live={!state.connected && state.snapshot && <div className="connection-bar">pacer isn't responding. Retrying…</div>}
    mainClass={`pc-main${!loading && !outdated && ["start","overview","review","settings","hosts","add-executor","sessions","terminal","setup"].includes(route.name)?" pc-main--canvas":""}`}
    main={loading ? <Skeleton /> : outdated ? <section className="pc-notice"><SectionHeading>Update pacer to use this view</SectionHeading><p>This screen needs a newer pacer service. Run <code>pacer update</code>, then reload this page.</p></section> : <DensityContext.Provider value={SETTINGS.has(route.name) ? "settings" : "compact"}>{children}</DensityContext.Provider>}
    overlay={assistantAvailable && <AssistantLoader route={route} narrow={narrow} repo={repo} repoLabel={repoLabel} onNewTask={onDelegate} />}
    dock={dockAvailable && dockOpen && <TerminalDock query={route.query} close={toggleDock} />}
    status={showStatusBar && <StatusBar route={route} snapshot={state.snapshot} registry={keys} terminal={dockAvailable ? { open: dockOpen, toggle: toggleDock } : undefined} />}
  /></NarrowContext.Provider>;
}
