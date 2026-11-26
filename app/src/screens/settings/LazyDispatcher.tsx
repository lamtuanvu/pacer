import { useEffect, useState } from "preact/hooks";
import type { ComponentType } from "preact";
import type { RouteQuery } from "../../router";
import { Button } from "../../ds/Button";
import { Skeleton } from "../../ds/Patterns";

type Tab = "overview" | "rules" | "profiles";
let resolvedView: ComponentType<{query:RouteQuery;tab?:Tab}>|null = null;
export function LazyDispatcher({query,tab}:{query:RouteQuery;tab?:Tab}) {
  const [View,setView]=useState<ComponentType<{query:RouteQuery;tab?:Tab}>|null>(() => resolvedView),[error,setError]=useState(false),[attempt,retry]=useState(0);
  useEffect(()=>{let active=true;setError(false);void import("./Dispatcher").then(module=>{resolvedView = module.DispatcherSection; if(active)setView(()=>module.DispatcherSection);}).catch(()=>{if(active)setError(true);});return()=>{active=false;};},[attempt]);
  return View?<View query={query} tab={tab}/>:error?<div role="alert">Dispatcher settings could not load. <Button onClick={()=>retry(n=>n+1)}>Try again</Button></div>:<Skeleton layout="settings" label="Loading dispatcher…"/>;
}
