import { LazySettings } from "./settings/LazySettings";
import { useContext } from "preact/hooks";
import { LazySetup } from "./setup/LazySetup";
import { SetupContext } from "./setup/context";
import type { Route } from '../router';
import { LazyTaskRoute } from "./LazyTaskRoute";
import { Overview, NeedsYouPage } from "./Overview";
import { LazyStartSession } from "./LazyStartSession";

import { RemoteHosts, HostDetail } from "./settings/Hosts";
import { AddExecutor } from "./settings/AddExecutor";
import { Sessions } from "./session/controller";
import { TerminalScreen } from "./terminal/Terminal";
/** Route mounting lives separately from browser bootstrap so every destination can be verified. */
export function Screen({route}:{route:Route}) {
 const { running } = useContext(SetupContext);
 switch(route.name) {
 case 'start': return <LazyStartSession/>;
 case 'setup': return <LazySetup query={route.query}/>;
 case 'overview': return <Overview query={route.query}/>;
 case 'review': return <NeedsYouPage query={route.query}/>;
 case 'sessions': return route.id?<>{running?.id === route.id && <p role="status">Running on {running.executor}</p>}<LazyTaskRoute key={route.id} id={route.id} query={route.query}/></>:<Sessions key={JSON.stringify(route.query)} query={route.query}/>;
 case 'terminal': return <TerminalScreen id={route.id} query={route.query}/>;
 case 'settings': return <LazySettings key={route.section ?? "general"} section={route.section} query={route.query}/>;
 case 'hosts': return route.alias?<HostDetail key={route.alias} alias={route.alias}/>:<RemoteHosts/>;
 case 'add-executor': return <AddExecutor host={route.host}/>;
 case 'loading': return null;
 }
}
