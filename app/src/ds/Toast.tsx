import { useRef } from 'preact/hooks';
import { Alert, type AlertTone } from './Alert';
import { Button } from './Button';
export function Toast({tone,title,message,onDismiss,onPause,onResume}: {tone:AlertTone;title:string;message?:string;onDismiss:()=>void;onPause:()=>void;onResume:()=>void}) {
  const active=useRef({hover:false,focus:false});
  const resume=()=>{if(!active.current.hover&&!active.current.focus)onResume();};
  return <div className="pc-toast" onMouseEnter={()=>{active.current.hover=true;onPause();}} onMouseLeave={()=>{active.current.hover=false;resume();}} onFocusCapture={()=>{active.current.focus=true;onPause();}} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null)){active.current.focus=false;resume();}}}>
    <Alert tone={tone} title={title}>{message}</Alert>
    <Button variant="quiet" size="sm" aria-label={`Dismiss ${title}`} onClick={onDismiss}>×</Button>
  </div>;
}
