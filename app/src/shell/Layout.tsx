import { counts as snapshotCounts } from "../../../src/view-model/selectors";
import { DensityContext } from '../ds/Density';
import { LoadingState } from "../ds/Patterns";
import { SectionHeading } from "../ds/SectionHeading";
import type { ComponentChildren } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Mark } from "../ds/Mark";
import type { StoreState } from "../data/store";
import type { Route } from "../router";
import { Rail } from "./Rail";
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
import { FrameContext, type FrameHeading } from "./slots";

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
  // A task's screen fills the Tasks list on the left and its session details on the right.
  const taskPanels = !narrow && wide && route.name === "sessions" && !!route.id && !!context && !state.sessionEnded;
  const [tasksOpen, setTasksOpen] = usePanelState("tasks", true);
  const [detailsOpen, setDetailsOpen] = usePanelState("session-details", true);
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null), [leftSlot, setLeftSlot] = useState<HTMLElement | null>(null);
  const [rightSlot, setRightSlot] = useState<HTMLElement | null>(null), [heading, setHeading] = useState<FrameHeading | null>(null);
  const slots = useMemo(() => ({ title: titleSlot, left: leftSlot, right: rightSlot, inline: !taskPanels, heading: setHeading,
    details: taskPanels ? { open: detailsOpen, toggle: () => setDetailsOpen(!detailsOpen) } : undefined }), [titleSlot, leftSlot, rightSlot, taskPanels, detailsOpen]);
  // One terminal screen at a time, and only where the full desktop frame (and a service connection) exists.
  const dockAvailable = showStatusBar && wide && !!context && route.name !== "terminal" && !state.sessionEnded;
  const toggleDock = () => {
    const here = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    // Opening remembers the opener; closing from outside the dock keeps focus where it is.
    if (!dockOpen || (here && !here.closest(".pc-dock"))) opener.current = here;
    setDockOpen(!dockOpen);
  };
  useEffect(() => {
    const offs = panelShortcuts(hasLeft ? () => setLeftOpen(!leftOpen) : taskPanels ? () => setTasksOpen(!tasksOpen) : undefined,
      dockAvailable ? toggleDock : undefined, taskPanels ? () => setDetailsOpen(!detailsOpen) : undefined).map(shortcut => keys.register(shortcut));
    return () => offs.forEach(off => off());
  }, [hasLeft, leftOpen, taskPanels, tasksOpen, detailsOpen, dockAvailable, dockOpen]);
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
  const topBar = <TopBar narrow={narrow} title={title} planner={state.snapshot?.planner ?? null} mode={state.snapshot?.mode?.mode ?? ""} connected={state.connected} lastUpdate={state.snapshot?.at ?? null} onDelegate={onDelegate} delegatePrimary={!["review", "start", "sessions"].includes(route.name)} showActions={route.name !== "setup"}
    heading={heading} context={setTitleSlot} />;
  const settings = SETTINGS.has(route.name) && (hasLeft
    ? <SidePanel side="left" label="Settings" open={leftOpen} onToggle={setLeftOpen}><Panel route={route} counts={counts} snapshot={state.snapshot} embedded /></SidePanel>
    : <Panel route={route} counts={counts} snapshot={state.snapshot} />);
  const tasks = taskPanels && <SidePanel side="left" label="Tasks" wide open={tasksOpen} onToggle={setTasksOpen}><div ref={setLeftSlot} className="pc-frame-slot" /></SidePanel>;
  const details = taskPanels && <SidePanel side="right" label="Session details" open={detailsOpen} onToggle={setDetailsOpen} bar={false}><div ref={setRightSlot} className="pc-frame-slot" /></SidePanel>;
  return <NarrowContext.Provider value={narrow}><FrameContext.Provider value={slots}><AppFrame narrow={narrow}
    top={narrow && route.name === "setup" ? null : topBar}
    activity={<Rail route={route} counts={counts} narrow={narrow} />}
    left={settings || tasks}
    right={details}
    live={!state.connected && state.snapshot && <div className="connection-bar">pacer isn't responding. Retrying…</div>}
    mainClass={`pc-main${!loading && !outdated && ["start","overview","review","settings","hosts","add-executor","sessions","terminal","setup"].includes(route.name)?" pc-main--canvas":""}`}
    main={loading ? <Skeleton /> : outdated ? <section className="pc-notice"><SectionHeading>Update pacer to use this view</SectionHeading><p>This screen needs a newer pacer service. Run <code>pacer update</code>, then reload this page.</p></section> : <DensityContext.Provider value={SETTINGS.has(route.name) ? "settings" : "compact"}>{children}</DensityContext.Provider>}
    dock={dockAvailable && dockOpen && <TerminalDock query={route.query} close={toggleDock} />}
    status={showStatusBar && <StatusBar route={route} snapshot={state.snapshot} registry={keys} terminal={dockAvailable ? { open: dockOpen, toggle: toggleDock } : undefined} />}
  /></FrameContext.Provider></NarrowContext.Provider>;
}
