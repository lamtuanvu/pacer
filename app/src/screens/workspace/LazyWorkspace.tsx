import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button } from "../../ds/Button";
import { Skeleton } from "../../ds/Patterns";
import type { RouteQuery } from "../../router";

type Props = { id?: string; panel?: string; query: RouteQuery };
export function LazyWorkspace(props: Props) {
  const [View,setView]=useState<ComponentType<Props>|null>(null),[error,setError]=useState(false),[attempt,retry]=useState(0);
  useEffect(()=>{
    let active=true;
    setError(false);
    void import("./Workspace").then(m=>{if(active)setView(()=>m.Workspace);}).catch(()=>{if(active)setError(true);});
    return ()=>{active=false;};
  },[attempt]);
  return View ? <View {...props}/> : error ? <div role="alert">Could not load workspace. <Button onClick={()=>retry(n=>n+1)}>Try again</Button></div> : <Skeleton layout="rows" label="Loading workspace"/>;
}
