import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Mark } from "../ds/Mark";
import type { StoreState } from "../data/store";
import type { Route } from "../router";
import { Rail } from "./Rail";
import { SettingsPanel } from "./SettingsPanel";

const SETTINGS = new Set(["settings", "hosts", "add-executor"]);
const NEEDS_READ_MODEL = new Set(["overview", "review"]);
function Skeleton() {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSlow(true), 1000); return () => clearTimeout(t); }, []);
  if (slow) return <p className="muted">Connecting to pacer…</p>;
  return <div className="pc-skeleton" aria-hidden="true">{[0, 1, 2].map(i => <div key={i} className="pc-skeleton__section"><span /><span /><span /></div>)}</div>;
}
/** Rail, optional settings panel, top bar and main. Screens render inside main. */
export function Layout({ route, state, title, header, children }: { route: Route; state: StoreState; title: string; header?: ComponentChildren; children: ComponentChildren }) {
  if (state.sessionEnded) return <main className="session-ended"><Mark /><h1>Session ended.</h1><p>Run <code>pacer open</code>.</p></main>;
  const counts = state.snapshot?.counts ?? null;
  const loading = route.name === "loading" || !state.snapshot;
  const outdated = !loading && NEEDS_READ_MODEL.has(route.name) && !state.features.readModel;
  return <div className="pc-app">
    <a href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to content</a>
    <Rail route={route} counts={counts} />
    {SETTINGS.has(route.name) && <SettingsPanel route={route} counts={counts} />}
    <div className="pc-work">
      {header ?? <header className="pc-topbar"><h1>{title}</h1></header>}
      <div aria-live="polite" role="status" className="pc-live">{!state.connected && state.snapshot && <div className="connection-bar">pacer isn't responding. Retrying…</div>}</div>
      <main id="main-content" tabIndex={-1} className="pc-main">
        {loading ? <Skeleton /> : outdated ? <section className="pc-notice"><h2>Update pacer to use this view</h2><p>This screen needs a newer pacer service. Run <code>pacer update</code>, then reload this page.</p></section> : children}
      </main>
    </div>
  </div>;
}
