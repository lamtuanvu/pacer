import { useContext } from "preact/hooks";
import { LazySetup } from "./setup/LazySetup";
import { SetupContext } from "./setup/context";
import type { Route } from '../router';
import { TaskRoute } from "./TaskResult";
import { Overview, NeedsYouPage } from "./Overview";

import { SettingsGeneral, RemoteHosts, HostDetail, AddExecutor } from "./settings/index";
import { Sessions, SessionRoute } from "./session/controller";
/** Route mounting lives separately from browser bootstrap so every destination can be verified. */
export function Screen({route}:{route:Route}) {
 const { running } = useContext(SetupContext);
 switch(route.name) {
 case 'setup': return <LazySetup query={route.query}/>;
 case 'overview': return <Overview query={route.query}/>;
 case 'review': return <NeedsYouPage query={route.query}/>;
 case 'sessions': return route.id?<>{running?.id === route.id && <p role="status">Running on {running.executor}</p>}<TaskRoute key={route.id} id={route.id} query={route.query}/></>:<Sessions key={route.query.repo??"all"} query={route.query}/>;
 case 'settings': return <SettingsGeneral key={route.section ?? "general"} section={route.section} query={route.query}/>;
 case 'hosts': return route.alias?<HostDetail key={route.alias} alias={route.alias}/>:<RemoteHosts/>;
 case 'add-executor': return <AddExecutor host={route.host}/>;
 case 'loading': return null;
 }
}
