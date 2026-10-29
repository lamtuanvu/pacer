import { LazyActivity } from "../plugins/LazyActivity";
import { LazySettings } from "./settings/LazySettings";
import { useContext } from "preact/hooks";
import { LazySetup } from "./setup/LazySetup";
import { SetupContext } from "./setup/context";
import type { Route } from '../router';
import { LazyResultPage } from "./review/LazyResultPage";
import { LazyTaskRoute } from "./LazyTaskRoute";
import { LazyInsights } from "./LazyInsights";
import { LazyDispatch } from "./dispatch/LazyDispatch";
import { LazyNewTask } from "./new-task/LazyNewTask";

import { Sessions } from "./session/controller";
import { TerminalScreen } from "./terminal/Terminal";
/** Route mounting lives separately from browser bootstrap so every destination can be verified. */
export function Screen({route}:{route:Route}) {
 const { running } = useContext(SetupContext);
 switch(route.name) {
 case 'task-failure': return <LazyResultPage key={route.id} id={route.id} query={route.query} failure/>;
 case 'task-review': return <LazyResultPage key={route.id} id={route.id} query={route.query}/>;
 case 'plugin': return <LazyActivity key={`${route.plugin}/${route.id}`} plugin={route.plugin} id={route.id}/>;
 case 'new-task': return <LazyNewTask query={route.query}/>;
 case 'setup': return <LazySetup query={route.query}/>;
 case 'insights': return <LazyInsights query={route.query}/>;
 case 'dispatch': return <LazyDispatch view="home" query={route.query}/>;
 case 'review': return <LazyDispatch view="needs-you" query={route.query}/>;
 case 'sessions': return route.id?<>{running?.id === route.id && <p role="status">Running on {running.executor}</p>}<LazyTaskRoute key={route.id} id={route.id} query={route.query}/></>:<Sessions key={JSON.stringify(route.query)} query={route.query}/>;
 case 'terminal': return <TerminalScreen id={route.id} query={route.query}/>;
 case 'settings': return <LazySettings key={route.section ?? "general"} section={route.section} query={route.query}/>;
 case 'hosts': return <LazySettings key={`hosts:${route.alias ?? ""}`} section="hosts" alias={route.alias} query={route.query}/>;
 case 'add-executor': return <LazySettings key="add-executor" section="add-executor" host={route.host} query={route.query}/>;
 case 'loading': return null;
 }
}
