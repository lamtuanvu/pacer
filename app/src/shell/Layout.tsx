import { counts as snapshotCounts } from "../../../src/view-model/selectors";
import { DensityContext } from '../ds/Density';
import { TextAction } from "../ds/Button";
import { LoadingState } from "../ds/Patterns";
import { SectionHeading } from "../ds/SectionHeading";
import type { ComponentChildren } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import { Mark } from "../ds/Mark";
import type { StoreState } from "../data/store";
import type { Route } from "../router";
import { Rail } from "./Rail";
import { TaskContext } from "../screens/task-shared";
import { SettingsPanel, SettingsPanelData } from "./SettingsPanel";
import { NarrowContext, useNarrow } from "./narrow";
import { TopBar } from "./TopBar";
import { StatusBar } from "./StatusBar";
import { keys } from "../keys/instance";

const SETTINGS = new Set(["settings", "hosts", "add-executor"]);
const NEEDS_READ_MODEL = new Set(["start", "overview", "review"]);
function Skeleton() {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSlow(true), 1000); return () => clearTimeout(t); }, []);
  if (slow) return <LoadingState label="Connecting to pacer…"/>;
  return <div className="pc-skeleton" aria-hidden="true">{[0, 1, 2].map(i => <div key={i} className="pc-skeleton__section"><span /><span /><span /></div>)}</div>;
}
/** Compact desktop header and rail; narrow screens keep touch navigation. */
export function Layout({ route, state, title, onDelegate = () => {}, children }: { route: Route; state: StoreState; title: string; onDelegate?: () => void; children: ComponentChildren }) {
  const narrow = useNarrow(route.query);
  const context = useContext(TaskContext), Panel = context ? SettingsPanelData : SettingsPanel;
  if (state.sessionEnded) return <main className="session-ended"><Mark /><h1>Session ended.</h1><p>Run <code>pacer open</code>.</p></main>;
  const counts = state.snapshot ? snapshotCounts(state.snapshot) : null;
  const loading = route.name === "loading" || !state.snapshot;
  const outdated = !loading && NEEDS_READ_MODEL.has(route.name) && !state.features.readModel;
  const topBar = <TopBar narrow={narrow} title={title} planner={state.snapshot?.planner ?? null} mode={state.snapshot?.mode?.mode ?? ""} connected={state.connected} lastUpdate={state.snapshot?.at ?? null} onDelegate={onDelegate} delegatePrimary={!["review", "start", "sessions"].includes(route.name)} showActions={route.name !== "setup"} />;
  return <NarrowContext.Provider value={narrow}><div className={`pc-app${narrow ? " pc-app--narrow" : ""}`}>
    <TextAction href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to content</TextAction>
    {!narrow && topBar}
    {narrow && <Rail route={route} counts={counts} narrow={narrow} />}
    <div className="pc-body">
      {!narrow && <Rail route={route} counts={counts} />}
      {SETTINGS.has(route.name) && <Panel route={route} counts={counts} snapshot={state.snapshot} />}
      <div className="pc-work">
        {narrow && route.name !== "setup" && topBar}
        <div aria-live="polite" role="status" className="pc-live-region">{!state.connected && state.snapshot && <div className="connection-bar">pacer isn't responding. Retrying…</div>}</div>
        <main id="main-content" tabIndex={-1} className={`pc-main${["settings","hosts","add-executor","sessions","setup"].includes(route.name)?" pc-main--canvas":""}`}>
          {loading ? <Skeleton /> : outdated ? <section className="pc-notice"><SectionHeading>Update pacer to use this view</SectionHeading><p>This screen needs a newer pacer service. Run <code>pacer update</code>, then reload this page.</p></section> : <DensityContext.Provider value={SETTINGS.has(route.name) ? "settings" : "compact"}>{children}</DensityContext.Provider>}
        </main>
      </div>
    </div>
    {!narrow && route.name !== "setup" && <StatusBar route={route} snapshot={state.snapshot} registry={keys} />}
  </div></NarrowContext.Provider>;
}
