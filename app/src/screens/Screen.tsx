import { workspaceKey, workspaceManager } from '../workspace/manager';
import { WorkspaceIdentity, WorkspaceScope, ViewActive } from '../workspace/state';
import { activateView, ViewVisibility } from '../workspace/view-host';
import { useViewPosition } from '../workspace/activation';
import { LazyActivity } from "../plugins/LazyActivity";
import { LazySettings } from "./settings/LazySettings";
import { useContext, useRef, useLayoutEffect } from "preact/hooks";
import { LazySetup } from "./setup/LazySetup";
import { SetupContext } from "./setup/context";
import type { Route } from '../router';
import { LazyTrace } from "./trace/LazyTrace";
import { LazyInsights } from "./LazyInsights";
import { LazyDispatch } from "./dispatch/LazyDispatch";
import { LazyNewTask } from "./new-task/LazyNewTask";

import { Sessions } from "./session/controller";
import { LazyWorkspace } from "./workspace/LazyWorkspace";
/** Route mounting lives separately from browser bootstrap so every destination can be verified. */
function RouteScreen({route}:{route:Route}) {
 const { running } = useContext(SetupContext);
 switch(route.name) {
 case 'task-failure': return <LazyTrace key={route.id} id={route.id} query={route.query}/>;
 case 'task-review': return <LazyTrace key={route.id} id={route.id} query={route.query}/>;
 case 'plugin': return <LazyActivity key={`${route.plugin}/${route.id}`} plugin={route.plugin} id={route.id}/>;
 case 'new-task': return <LazyNewTask query={route.query}/>;
 case 'setup': return <LazySetup query={route.query}/>;
 case 'insights': return <LazyInsights query={route.query}/>;
 case 'dispatch': return <LazyDispatch view="home" query={route.query}/>;
 case 'review': return <LazyDispatch view="needs-you" query={route.query}/>;
 case 'sessions': return route.id ? <LazyTrace key={route.id} id={route.id} query={route.query}/> : <Sessions query={route.query}/>;
 case 'terminal': return <LazyWorkspace id={route.id} panel={route.panel} query={route.query}/>;
 case 'settings': return <LazySettings key={route.section ?? "general"} section={route.section} query={route.query}/>;
 case 'hosts': return <LazySettings key={`hosts:${route.alias ?? ""}`} section="hosts" alias={route.alias} query={route.query}/>;
 case 'add-executor': return <LazySettings key="add-executor" section="add-executor" host={route.host} query={route.query}/>;
 case 'loading': return null;
 }
}

function detailId(route: Route) { return ['terminal', 'sessions', 'task-review', 'task-failure'].includes(route.name) && 'id' in route ? route.id : undefined; }
export function routeWorkspaceKey(identity: string, route: Route) {
 return workspaceKey(identity, detailId(route), `${detailId(route) ? route.name === 'terminal' ? 'workspace' : 'trace' : route.name}:${'section' in route ? route.section ?? '' : ''}:${JSON.stringify(route.query)}`);
}
function HostedView({ route, active, scope }: { route: Route; active: boolean; scope: string }) {
 useViewPosition(scope, active);
 return <WorkspaceScope.Provider value={scope}><ViewActive.Provider value={active}><ViewVisibility active={active}><div className="pc-view-content" data-workspace-root={scope}><RouteScreen route={route}/></div></ViewVisibility></ViewActive.Provider></WorkspaceScope.Provider>;
}
export function Screen({ route }: { route: Route }) {
 const identity = useContext(WorkspaceIdentity), scope = routeWorkspaceKey(identity, route);
 const sessionsKey = workspaceKey(identity, undefined, "open-sessions");
 const saved = workspaceManager.get<unknown>(sessionsKey, "openSessions", []);
 const views = useRef<{ key: string; route: Route }[]>(Array.isArray(saved) ? saved.filter(view => view && typeof view.key === "string" && view.route && detailId(view.route)).slice(-5) : []), owner = useRef(identity);
 if (owner.current !== identity) { views.current = Array.isArray(saved) ? saved.filter(view => view && typeof view.key === "string" && view.route && detailId(view.route)).slice(-5) : []; owner.current = identity; }
 const detail = detailId(route), key = detail ? `${scope}:${route.name === 'terminal' ? 'workspace' : 'trace'}` : null;
 views.current = activateView(views.current, key, route);
 const openSessions = JSON.stringify(views.current);
 useLayoutEffect(() => { workspaceManager.set(sessionsKey, "openSessions", views.current); }, [sessionsKey, openSessions]);
 return <>{views.current.map(view => <HostedView key={view.key} route={view.route} scope={routeWorkspaceKey(identity, view.route)} active={view.key === key}/>)}{!key && <HostedView key={scope} route={route} scope={scope} active/>}</>;
}
