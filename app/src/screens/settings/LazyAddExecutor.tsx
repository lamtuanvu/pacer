import {useEffect,useState} from "preact/hooks";
import type {ComponentType} from "preact";
import {Button} from "../../ds/Button";
import {LoadingState} from "../../ds/Patterns";

/** Add executor is opened rarely; it loads on first visit to keep the app bundle within budget (UI-3). */
export function LazyAddExecutor({host}:{host?:string}){
 const[View,setView]=useState<ComponentType<{host?:string}>|null>(null),[error,setError]=useState(""),[attempt,retry]=useState(0);
 useEffect(()=>{let active=true;setError("");void import("./AddExecutor").then(m=>{if(active)setView(()=>m.AddExecutor);}).catch(()=>{if(active)setError("Add executor unavailable.");});return()=>{active=false;};},[attempt]);
 return View?<View host={host}/>:error?<div role="alert">{error}<Button onClick={()=>retry(n=>n+1)}>Try again</Button></div>:<LoadingState label="Loading executor setup…"/>;
}
