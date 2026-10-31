import {useEffect,useState} from "preact/hooks";
import type {ComponentType} from "preact";
import {Button} from "../../ds/Button";
import {Skeleton} from "../../ds/Patterns";

type ThreadProps={id:string;closed:boolean;notice?:string|null};
/** The thread and its view model load on first use, like LazyWork, to keep app.js inside its budget. */
export function LazyThread(props:ThreadProps){
 const[View,setView]=useState<ComponentType<ThreadProps>|null>(null),[error,setError]=useState(""),[attempt,retry]=useState(0);
 useEffect(()=>{let active=true;setError("");void import("./Thread").then(m=>{if(active)setView(()=>m.Thread);}).catch(()=>{if(active)setError("Messages unavailable.");});return()=>{active=false;};},[attempt]);
 return View?<View {...props}/>:error?<div role="alert">{error}<Button onClick={()=>retry(n=>n+1)}>Try again</Button></div>:<Skeleton layout="rows" label="Loading messages…"/>;
}
