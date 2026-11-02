import { useEffect, useState } from 'preact/hooks';
import type { ComponentType } from 'preact';
import type { RouteQuery } from '../../router';
import { Button } from '../../ds/Button';
import { Skeleton } from '../../ds/Patterns';
import { Alert } from '../../ds/Alert';
type Props = {section?:string;query:RouteQuery;host?:string;alias?:string};
/** Editors load on demand; overview and running work do not pay their bundle cost. */
const resolvedViews = new Map<string, ComponentType<Props>>();
export function LazySettings(props:Props) {
  const kind = props.section === 'plugins' ? 'plugins' : props.section?.startsWith('plugins/') ? 'plugin' : 'general';
  const [loaded,setView]=useState<{kind:string;View:ComponentType<Props>}|null>(() => { const View = resolvedViews.get(kind); return View ? {kind,View} : null; }),[error,setError]=useState(false),[attempt,retry]=useState(0);
  useEffect(()=>{
    let active=true;setError(false);
    void (props.section === 'plugins' ? import('./PluginsPage').then(m=>()=><m.PluginsPage/>) : props.section?.startsWith('plugins/') ? import('./PluginSettingsPage').then(m=>m.PluginSettingsPage) : import('./General').then(m=>m.SettingsGeneral)).then(View=>{resolvedViews.set(kind,View);if(active)setView({kind,View});}).catch(()=>{if(active)setError(true);});
    return()=>{active=false;};
  },[attempt,kind]);
  const View = loaded?.kind === kind ? loaded.View : resolvedViews.get(kind);
  return View?<View {...props}/>:error?<Alert tone="error" title="Could not load settings"><Button onClick={()=>retry(n=>n+1)}>Try again</Button></Alert>:<Skeleton layout="settings" label="Loading settings…" />;
}
