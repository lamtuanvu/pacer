import {useEffect,useState} from "preact/hooks";
import type {ComponentType} from "preact";
import {Button} from "../../ds/Button";
import {LoadingState} from "../../ds/Patterns";

export function LazyWork({id}:{id:string}){
 const[View,setView]=useState<ComponentType<{id:string}>|null>(null),[error,setError]=useState(""),[attempt,retry]=useState(0);
 useEffect(()=>{let active=true;setError("");void import("./WorkView").then(m=>{if(active)setView(()=>m.WorkView);}).catch(()=>{if(active)setError("Work history unavailable.");});return()=>{active=false;};},[attempt]);
 return View?<View id={id}/>:error?<div role="alert">{error}<Button onClick={()=>retry(n=>n+1)}>Try again</Button></div>:<LoadingState label="Loading work…"/>;
}
