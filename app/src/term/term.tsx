import { Checkbox, Field, TextInput } from "../ds/Controls";
import { clock } from "../../../src/view-model/time";
import { useDialogs } from "../ds/useDialogs";
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Button } from "../ds/Button";
import { SessionClient, type SessionState } from "./client";
import { filesFromPaste } from "../model/attachments";
import { terminalDocument } from "./document";
export interface TerminalViewProps { id:string; url?:string; label?:string; cols?:number; rows?:number; control?:boolean; resize?:boolean; live?:boolean; controller?:string|null; driving?:boolean; takeRequested?:boolean; onTakeSent?:()=>void; takeover?:ComponentChildren; conversation?:boolean; shell?:boolean; onFiles?:(files:File[])=>void; footer?:HTMLElement|null }
/** Loaded only by import(). The shell may disable its shortcuts when data-session-control is true. */
export function TerminalView({id,url,label='pacer app',cols=120,rows=40,control=false,resize=true,live=true,controller=null,driving=false,takeRequested=false,onTakeSent,takeover,conversation=false,shell=false,onFiles,footer}:TerminalViewProps){
 const dialogs=useDialogs();
 const mount=useRef<HTMLDivElement>(null),pane=useRef<HTMLDivElement>(null),client=useRef<SessionClient>();
 const [state,setState]=useState<SessionState>({status:'connecting',you:false,controller,cols,rows,viewers:0});
 const [reader,setReader]=useState(false),[error,setError]=useState(''),[generation,setGeneration]=useState(0),[exitAt,setExitAt]=useState('');
 const terminal=useRef<Terminal>(),searchAddon=useRef<SearchAddon>(),taken=useRef(false);
 const [search,setSearch]=useState(''),[searchFound,setSearchFound]=useState<boolean|null>(null);
 useEffect(()=>{
  if(!mount.current||!pane.current)return;
  setError('');setExitAt('');
  const nonce=document.querySelector<HTMLMetaElement>('meta[name="pacer-style-nonce"]')?.content??'';
  const term=new Terminal({documentOverride:terminalDocument(document,nonce),cols,rows,disableStdin:true,screenReaderMode:reader,fontFamily:getComputedStyle(mount.current).getPropertyValue('--font-mono').trim(),fontSize:parseFloat(getComputedStyle(mount.current).getPropertyValue('--type-code-size')),scrollback:10000,convertEol:false});
  terminal.current=term;const fit=new FitAddon();term.loadAddon(fit);
  if(shell){const addon=new SearchAddon();term.loadAddon(addon);searchAddon.current=addon;}
  term.open(mount.current);
  const applyTheme=()=>{const style=getComputedStyle(mount.current!);const token=(name:string)=>style.getPropertyValue(name).trim();term.options.theme={background:token('--surface-page'),foreground:token('--ink'),cursor:token('--ink'),selectionBackground:token('--line'),black:token('--ink'),red:token('--bad-fg'),green:token('--good-fg'),yellow:token('--warn-fg'),blue:token('--info-fg'),magenta:token('--link'),cyan:token('--info-fg'),white:token('--ink-secondary'),brightBlack:token('--ink-muted'),brightRed:token('--bad-fill'),brightGreen:token('--good-fill'),brightYellow:token('--warn-fill'),brightBlue:token('--link'),brightMagenta:token('--link'),brightCyan:token('--info-fg'),brightWhite:token('--ink')};};
  applyTheme();const observer=new MutationObserver(applyTheme);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','class']});const media=matchMedia('(prefers-color-scheme: dark)');media.addEventListener('change',applyTheme);
  const endpoint=new URL(url??`/v2/tasks/${encodeURIComponent(id)}/session`,location.href);endpoint.protocol=['https:','wss:'].includes(endpoint.protocol)?'wss:':'ws:';
  let lastYou=false,lastCols=cols,lastRows=rows;
  let resizeTimer:ReturnType<typeof setTimeout>|undefined;
  const scale=()=>{
   if(!mount.current||!pane.current)return;
   // A hidden pane (another tab is open) measures 0×0; fitting it would shrink the agent's PTY.
   if(!pane.current.clientWidth||!pane.current.clientHeight)return;
   if(client.current?.state.you){mount.current.style.transform='';mount.current.style.width='100%';mount.current.style.height='100%';if(resize){fit.fit();client.current.resize(term.cols,term.rows);}return;}
   // PTY geometry is authoritative for viewers. Scale instead of reflowing it.
   mount.current.style.width=`${term.cols*term.options.fontSize!*0.61}px`;mount.current.style.height=`${term.rows*term.options.fontSize!*1.2}px`;
   const screen=mount.current.querySelector<HTMLElement>('.xterm-screen');
   if(screen){mount.current.style.width=`${screen.offsetWidth}px`;mount.current.style.height=`${screen.offsetHeight}px`;const factor=conversation?1:Math.min(1,pane.current.clientWidth/Math.max(1,screen.offsetWidth),pane.current.clientHeight/Math.max(1,screen.offsetHeight));mount.current.style.transform=`scale(${factor})`;}
  };
  const connection=new SessionClient({url:endpoint.href,label,cols,rows,control:control&&live,autoControl:!takeRequested,onSnapshot:s=>{term.reset();term.resize(s.cols,s.rows);term.write(s.scrollbackAnsi);term.write(s.screenAnsi,scale);},onOutput:bytes=>term.write(bytes),onState:s=>{setState(s);term.options.disableStdin=!s.you;if(term.cols!==s.cols||term.rows!==s.rows)term.resize(s.cols,s.rows);if(s.status==='exited')setExitAt(clock(Date.now()/1000,Date.now()/1000));if(s.you!==lastYou||s.cols!==lastCols||s.rows!==lastRows){lastYou=s.you;lastCols=s.cols;lastRows=s.rows;scale();}}});
  client.current=connection;
  term.attachCustomKeyEventHandler(event=>{if(connection.state.you&&event.ctrlKey&&event.code==='BracketRight'){if(event.type==='keydown')connection.release();event.preventDefault();event.stopPropagation();return false;}
   // A watcher's keys never reach the agent; let Tab move focus out of the terminal.
   if(!connection.state.you&&event.key==='Tab')return false;
   return true;});
  const input=term.onData(data=>connection.input(data));
  const resizer=new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(scale,150);});resizer.observe(pane.current);
  connection.connect();scale();
  return ()=>{clearTimeout(resizeTimer);resizer.disconnect();observer.disconnect();media.removeEventListener('change',applyTheme);input.dispose();connection.dispose();term.dispose();client.current=undefined;terminal.current=undefined;searchAddon.current=undefined;};
 },[id,url,label,control,resize,live,shell,generation]);
 useEffect(()=>{if(terminal.current)terminal.current.options.screenReaderMode=reader;},[reader]);
 // Focus on the next frame, after the control state renders.
 useEffect(()=>{if(!state.you)return;const frame=requestAnimationFrame(()=>terminal.current?.focus());return ()=>cancelAnimationFrame(frame);},[state.you]);
 useEffect(()=>{if(takeRequested&&!taken.current&&state.status==='live'){taken.current=true;void client.current?.take(message=>dialogs.confirm(message,'Take control','Take control')).then(()=>onTakeSent?.()).catch(e=>setError(String(e)));}},[takeRequested,state.status]);
 const mode=state.status==='exited'?`Exited with code ${state.code ?? 'unknown'}${state.signal?` (${state.signal})`:''}${exitAt?` at ${exitAt}`:''}`:state.you?'You have control':state.status==='live'?'Watching · read-only':state.status==='resyncing'?'Refreshing snapshot…':state.status==='error'?'Session error':state.status==='reconnecting'?'Reconnecting…':'Connecting…';
 const hint=state.you?`Keystrokes go to your ${shell?'shell':'agent'}. Ctrl-] to release.`:shell?'Nothing you type reaches the shell until you take control.':conversation?'Nothing you type reaches the agent. Closing this window leaves your conversation running.':'Nothing you type reaches the agent.';
 const readerToggle=<label><Checkbox checked={reader} onChange={e=>setReader(e.currentTarget.checked)}/> Screen reader</label>;
 const toggleControl=()=>{if(state.you)client.current?.release();else{void client.current?.take(message=>dialogs.confirm(message,'Take control','Take control')).catch(e=>setError(String(e)));}};
 const reconnect=()=>setGeneration(n=>n+1);
 const find=(backward=false)=>{if(!search.trim()){searchAddon.current?.clearDecorations();setSearchFound(null);return;}setSearchFound(backward?searchAddon.current?.findPrevious(search)??false:searchAddon.current?.findNext(search)??false);};
 return <section className={`pc-terminal-view${footer?' pc-terminal-view--fill':''}`} data-session-control={state.you?'true':'false'} onKeyDown={e=>{if(state.you)e.stopPropagation();}}
  onPasteCapture={event=>{if(!onFiles)return;const files=filesFromPaste(event);if(files.length){event.preventDefault();event.stopPropagation();const text=event.clipboardData?.getData('text/plain');if(text&&state.you)terminal.current?.paste(text);onFiles(files);}}}
  onDragOver={event=>{if(onFiles)event.preventDefault();}} onDrop={event=>{if(onFiles){event.preventDefault();onFiles(Array.from(event.dataTransfer?.files??[]));}}}>
  {dialogs.dialog}
  {shell&&<div className="pc-terminal-search" role="search" aria-label="Terminal output search">
   <Field label="Search terminal output"><TextInput value={search} onInput={event=>{setSearch(event.currentTarget.value);setSearchFound(null);}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();find(event.shiftKey);}}}/></Field>
   <Button size="sm" disabled={!search.trim()} onClick={()=>find(true)}>Previous</Button>
   <Button size="sm" disabled={!search.trim()} onClick={()=>find()}>Next</Button>
   {searchFound===false&&<span role="status">No match</span>}
  </div>}
  <div className={`pc-terminal-frame${state.you?' pc-terminal-frame--control':''}${footer?' pc-terminal-frame--fill':''}`}><div className="pc-terminal-pane" ref={pane}><div ref={mount} className="pc-terminal-mount"/></div>
   {!footer&&<div className="pc-terminal-strip"><strong role="status" aria-live="polite">{mode}</strong><span>{hint}</span><span>{state.cols}×{state.rows}</span>{readerToggle}</div>}
  </div>
  {footer?createPortal(<div className={`pc-session-control${state.you?' pc-session-control--driving':''}`}>
   <strong className="pc-session-control__mode" role="status" aria-live="polite"><span className="pc-session-control__dot" aria-hidden="true"/><span className="pc-session-control__label" title={mode}>{mode}</span></strong>
   <span className="pc-session-control__hint" title={hint}>{hint}</span>
   {state.message&&<span role="status">{state.message}</span>}{error&&<span role="alert">{error}</span>}
   <span className="grow"/>
   {control&&live&&state.status==='live'&&<Button size="sm" aria-pressed={state.you} title={hint} onClick={toggleControl}>{state.you?'Release control':'Take control'}</Button>}
   {state.status==='error'&&<Button size="sm" onClick={reconnect}>Reconnect</Button>}
   <span className="pc-session-control__size">{state.cols}×{state.rows}</span>{readerToggle}
  </div>,footer):<>
  {state.message&&<p role="status">{state.message}</p>}{error&&<p role="alert">{error}</p>}
  <TerminalControls control={control} live={live} driving={driving} shell={shell} state={state} takeover={takeover} onControl={toggleControl} onReconnect={reconnect}/>
  </>}
 </section>;
}
export function TerminalControls({control,live,driving,shell,state,takeover,onControl,onReconnect}:{control:boolean;live:boolean;driving?:boolean;shell?:boolean;state:SessionState;takeover?:ComponentChildren;onControl:()=>void;onReconnect?:()=>void}){
 return <div className="pc-session-row">{control&&live&&state.status==='live'&&<Button aria-pressed={state.you} onClick={onControl}>{state.you?(driving?'Hand back':'Release control'):'Take control'}</Button>}
  {takeover}{state.status==='error'&&<Button onClick={onReconnect}>Reconnect</Button>}
  <span className="pc-session-muted">{shell?'Only one window can type into this shell at a time. Closing this page leaves it running.':driving?'Ends this session and sends the task to review':state.you?'Other viewers stay read-only while you hold control.':'Only for agents running interactively. pacer pauses its idle timer while you type.'}</span></div>;
}
export default TerminalView;
