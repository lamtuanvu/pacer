import {useEffect,useState} from "preact/hooks";
import type {ComponentType} from "preact";
import {Button} from "../../ds/Button";
import {LoadingState} from "../../ds/Patterns";
import type {RouteQuery} from "../../router";

/** Dispatched work is a secondary tab; its list loads on first open to keep the app bundle within budget (UI-3). */
export function LazyWorkList({query}:{query:RouteQuery}){
 const[View,setView]=useState<ComponentType<{query:RouteQuery}>|null>(null),[error,setError]=useState(""),[attempt,retry]=useState(0);
 useEffect(()=>{let active=true;setError("");void import("./WorkList").then(m=>{if(active)setView(()=>m.WorkList);}).catch(()=>{if(active)setError("Dispatched work unavailable.");});return()=>{active=false;};},[attempt]);
 return View?<View query={query}/>:error?<div role="alert">{error}<Button onClick={()=>retry(n=>n+1)}>Try again</Button></div>:<LoadingState label="Loading work…"/>;
}
