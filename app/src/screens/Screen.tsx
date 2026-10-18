import type { Route } from '../router';
import { Setup } from './Setup';
import { Overview } from './Overview';
import { Review } from './Review';
import { SettingsGeneral, RemoteHosts, HostDetail, AddExecutor } from './settings/index';
import { Sessions, SessionRoute } from './session/controller';
/** Route mounting lives separately from browser bootstrap so every destination can be verified. */
export function Screen({route}:{route:Route}) {
 switch(route.name) {
 case 'overview': return <Overview query={route.query}/>;
 case 'review': return <Review route={route}/>;
 case 'sessions': return route.id?<SessionRoute key={route.id} id={route.id}/>:<Sessions query={route.query}/>;
 case 'settings': return <SettingsGeneral section={route.section}/>;
 case 'hosts': return route.alias?<HostDetail key={route.alias} alias={route.alias}/>:<RemoteHosts/>;
 case 'add-executor': return <AddExecutor host={route.host}/>;
 case 'setup': return <Setup/>;
 case 'loading': return null;
 default: return <section><h1>Page not found</h1><a href="#/">Go to Overview</a></section>;
 }
}
