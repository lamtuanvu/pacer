import { useEffect, useState } from 'preact/hooks';
import type { ComponentType } from 'preact';
import type { RouteQuery } from '../../router';
import { Button } from '../../ds/Button';
import { Alert } from '../../ds/Alert';
type Props = {section?:string;query:RouteQuery;host?:string;alias?:string};
/** Editors load on demand; overview and running work do not pay their bundle cost. */
export function LazySettings(props:Props) {
  const [View,setView]=useState<ComponentType<Props>|null>(null),[error,setError]=useState(false),[attempt,retry]=useState(0);
  useEffect(()=>{
    let active=true;setError(false);
    void (props.section === 'plugins' ? import('./PluginsPage').then(m=>m.PluginsPage) : props.section?.startsWith('plugins/') ? import('./PluginSettingsPage').then(m=>m.PluginSettingsPage) : import('./General').then(m=>m.SettingsGeneral)).then(View=>{if(active)setView(()=>View);}).catch(()=>{if(active)setError(true);});
    return()=>{active=false;};
  },[attempt]);
  return View?<View {...props}/>:error?<Alert tone="error" title="Could not load settings"><Button onClick={()=>retry(n=>n+1)}>Try again</Button></Alert>:<p role="status">Loading settings…</p>;
}
