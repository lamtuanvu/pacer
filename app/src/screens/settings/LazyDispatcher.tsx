import { useEffect, useState } from "preact/hooks";
import type { ComponentType } from "preact";
import type { RouteQuery } from "../../router";
import { Button } from "../../ds/Button";
import { LoadingState } from "../../ds/Patterns";

export function LazyDispatcher({query}:{query:RouteQuery}) {
  const [View,setView]=useState<ComponentType<{query:RouteQuery}>|null>(null),[error,setError]=useState(false),[attempt,retry]=useState(0);
  useEffect(()=>{let active=true;setError(false);void import("./Dispatcher").then(module=>{if(active)setView(()=>module.DispatcherSection);}).catch(()=>{if(active)setError(true);});return()=>{active=false;};},[attempt]);
  return View?<View query={query}/>:error?<div role="alert">Dispatcher settings could not load. <Button onClick={()=>retry(n=>n+1)}>Try again</Button></div>:<LoadingState label="Loading dispatcher…"/>;
}
