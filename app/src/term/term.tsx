import { Checkbox, Field, TextInput } from "../ds/Controls";
import { clock } from "../../../src/view-model/time";
import { useDialogs } from "../ds/useDialogs";
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Button, IconButton } from "../ds/Button";
import { type SessionState } from "./client";
import { sessionRuntime, type SessionRuntime } from "./runtime";
import { filesFromPaste } from "../model/attachments";
import { terminalDocument } from "./document";
import { classifyTerminalLink, findWrappedFileLinks, shouldActivateTerminalLink, type TerminalLink } from "./links";
import { FIND_EVENT } from "../shell/shell-commands";
export interface TerminalActions { find: () => void; clear: () => void; reader: () => void; release: () => void }
export interface TerminalViewProps { preview?:boolean; externalControls?:boolean; autoControl?:boolean; onActions?: (actions: TerminalActions | null) => void; onInputLocked?: (locked: boolean) => void; onControlChange?: (you: boolean) => void; id:string; attempt?:number|null; attemptStartedAt?:number; url?:string; label?:string; cols?:number; rows?:number; control?:boolean; resize?:boolean; live?:boolean; controller?:string|null; driving?:boolean; takeRequested?:boolean; onTakeSent?:()=>void; takeover?:ComponentChildren; conversation?:boolean; shell?:boolean; onFiles?:(files:File[])=>void; onOpenFile?:(reference:string,line?:number,column?:number)=>void; footer?:HTMLElement|null }
/** Loaded only by import(). The shell may disable its shortcuts when data-session-control is true. */
export function TerminalView({id,attempt,attemptStartedAt,url,label='pacer app',cols=120,rows=40,control=false,resize=true,live=true,controller=null,driving=false,takeRequested=false,onTakeSent,takeover,conversation=false,shell=false,onFiles,onOpenFile,footer,onActions,onInputLocked,onControlChange,preview=false,externalControls=false,autoControl=true}:TerminalViewProps){
 const dialogs=useDialogs();
 const [acquisition,setAcquisition]=useState(0);
 const [acquired,setRuntime]=useState<SessionRuntime|null>(null);
 const runtime=acquired?.target===`${shell?'terminal':'task'}:${id}`?acquired:null;
 useEffect(()=>{try{setRuntime(sessionRuntime(id,url,shell)??null);}catch{setRuntime(null);setError('Terminal limit reached. Hide or hand back a session before opening another.');setState(s=>({...s,status:'error'}));}},[id,url,shell,acquisition]);
 useEffect(()=>{runtime?.update({control,live,attempt,attemptStartedAt,cols,rows,label,autoControl});},[runtime,control,live,attempt,attemptStartedAt,cols,rows,label,autoControl]);
 const mount=useRef<HTMLDivElement>(null),pane=useRef<HTMLDivElement>(null),client=useRef<SessionRuntime>();
 const [state,setState]=useState<SessionState>({status:'connecting',you:false,controller,cols,rows,viewers:0});
 const [reader,setReader]=useState(false),[error,setError]=useState(''),[exitAt,setExitAt]=useState('');
 const terminal=useRef<Terminal>(),searchAddon=useRef<SearchAddon>(),taken=useRef(false);
 const viewRef=useRef({control,live});viewRef.current={control,live};
 const resizeRef=useRef(resize);resizeRef.current=resize;
 const openFileRef=useRef(onOpenFile);openFileRef.current=onOpenFile;
 const [findOpen,setFindOpen]=useState(false),[caseSensitive,setCaseSensitive]=useState(false),[matches,setMatches]=useState({count:0,index:0});
 const [search,setSearch]=useState(''),[searchFound,setSearchFound]=useState<boolean|null>(null);
 useEffect(()=>{
  if(!runtime)return;
  if(!mount.current||!pane.current)return;
  setError('');setExitAt('');
  const nonce=document.querySelector<HTMLMetaElement>('meta[name="pacer-style-nonce"]')?.content??'';
  // xterm multiplies the measured 14px glyph cell at the 12px code size.
  const owned=runtime.ownTerminal(()=>{
   const term=new Terminal({documentOverride:terminalDocument(document,nonce),cols,rows,disableStdin:true,screenReaderMode:reader,fontFamily:getComputedStyle(mount.current!).getPropertyValue('--font-mono').trim(),fontSize:parseFloat(getComputedStyle(mount.current!).getPropertyValue('--type-code-size')),lineHeight:19/14,scrollback:10000,convertEol:false});
   const fit=new FitAddon();term.loadAddon(fit);
   const host=document.createElement('div');host.className='pc-terminal-mount';host.style.width='100%';host.style.height='100%';
   mount.current!.append(host);term.open(host);
   const search=new SearchAddon();if(shell)term.loadAddon(search);
   return {value:{term,fit,host,search},renderer:{reset:(cols:number,rows:number)=>{term.reset();term.resize(cols,rows);},write:(bytes:Uint8Array)=>term.write(bytes),state:(s:SessionState)=>{term.options.disableStdin=!s.you;if(term.cols!==s.cols||term.rows!==s.rows)term.resize(s.cols,s.rows);}},dispose:()=>{term.dispose();host.remove();}};
  });
  const {term,fit,host}=owned;
  if(pane.current.clientWidth&&pane.current.clientHeight)mount.current.append(host);
  terminal.current=term;searchAddon.current=shell?owned.search:undefined;
  const results=shell?owned.search.onDidChangeResults(result=>setMatches({count:result.resultCount,index:result.resultIndex+1})):undefined;
  const activate=(event:MouseEvent,target:TerminalLink|null)=>{
   if(!target||!shouldActivateTerminalLink(!!client.current?.state.you,event))return;
   if(target.kind==='file'&&!openFileRef.current)return;
   event.preventDefault();
   if(target.kind==='web')window.open(target.url,'_blank','noopener,noreferrer');
   else openFileRef.current?.(target.reference,target.line,target.column);
  };
  term.options.linkHandler={allowNonHttpProtocols:!!onOpenFile,activate:(event,uri)=>activate(event,classifyTerminalLink(uri,true)),
   hover:(_event,uri)=>{if(term.element)term.element.title=uri;},leave:()=>{if(term.element)term.element.removeAttribute('title');}};
  const webLinks=new WebLinksAddon((event,uri)=>activate(event,classifyTerminalLink(uri,false)));term.loadAddon(webLinks);
  const fileLinks=onOpenFile?term.registerLinkProvider({provideLinks(bufferLineNumber,callback){
   const buffer=term.buffer.active,row=bufferLineNumber-1;
   let first=row,last=row;
   while(first>0&&row-first<16&&buffer.getLine(first)?.isWrapped)first--;
   while(last+1<buffer.length&&last-row<16&&buffer.getLine(last+1)?.isWrapped)last++;
   const lines=Array.from({length:last-first+1},(_,index)=>{
    const line=buffer.getLine(first+index),text=line?.translateToString(true)??'',cells:number[]=[],endCells:number[]=[];
    if(line){let offset=0;for(let x=0;x<line.length&&offset<text.length;x++){
     const cell=line.getCell(x);if(!cell||cell.getWidth()===0)continue;
     const chars=cell.getChars()||' ';
     for(let n=0;n<chars.length&&offset<text.length;n++){cells[offset]=x+1;endCells[offset++]=x+Math.max(1,cell.getWidth());}
    }}
    return{text,wrapped:!!line?.isWrapped,cells,endCells};
   });
   callback(findWrappedFileLinks(lines,row-first).map(link=>({
    text:link.target.reference,range:{start:{x:link.start.x,y:link.start.y+first},end:{x:link.end.x,y:link.end.y+first}},
    activate:event=>activate(event,link.target),
    hover:()=>{if(term.element)term.element.title=link.target.reference;},
    leave:()=>{if(term.element)term.element.removeAttribute('title');},
   })));
  }}):undefined;

  const applyTheme=()=>{
   const style=getComputedStyle(mount.current!);
   const token=(name:string)=>style.getPropertyValue(`--terminal-${name}`).trim();
   term.options.minimumContrastRatio=4.5;
   term.options.theme={background:token('background'),foreground:token('foreground'),cursor:token('foreground'),cursorAccent:token('background'),selectionBackground:token('selection'),
    black:token('black'),red:token('red'),green:token('green'),yellow:token('yellow'),blue:token('blue'),magenta:token('magenta'),cyan:token('cyan'),white:token('white'),
    brightBlack:token('bright-black'),brightRed:token('bright-red'),brightGreen:token('bright-green'),brightYellow:token('bright-yellow'),brightBlue:token('bright-blue'),brightMagenta:token('bright-magenta'),brightCyan:token('bright-cyan'),brightWhite:token('bright-white')};
  };
  applyTheme();const observer=new MutationObserver(applyTheme);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','class']});const media=matchMedia('(prefers-color-scheme: dark)');media.addEventListener('change',applyTheme);
  let lastYou=false,lastCols=cols,lastRows=rows;
  let resizeTimer:ReturnType<typeof setTimeout>|undefined;
  const scale=()=>{
   if(!mount.current||!pane.current||host.parentElement!==mount.current)return;
   // A hidden pane (another tab is open) measures 0×0; fitting it would shrink the agent's PTY.
   if(!pane.current.clientWidth||!pane.current.clientHeight)return;
   if(client.current?.state.you){mount.current.style.transform='';mount.current.style.width='100%';mount.current.style.height='100%';if(resizeRef.current&&viewRef.current.control&&viewRef.current.live){fit.fit();client.current.resize(term.cols,term.rows);}return;}
   // Followers keep authoritative PTY geometry and share the same fill-pane chrome via CSS scale.
   mount.current.style.width=`${term.cols*term.options.fontSize!*0.61}px`;mount.current.style.height=`${term.rows*term.options.fontSize!*1.2}px`;
   const screen=mount.current.querySelector<HTMLElement>('.xterm-screen');
   if(screen){mount.current.style.width=`${screen.offsetWidth}px`;mount.current.style.height=`${screen.offsetHeight}px`;}
   const width=Math.max(1,mount.current.offsetWidth),height=Math.max(1,mount.current.offsetHeight);
   // Fit the content box: clientWidth includes padding that the mount does not occupy.
   const pad=getComputedStyle(pane.current);
   const availW=Math.max(1,pane.current.clientWidth-parseFloat(pad.paddingLeft)-parseFloat(pad.paddingRight));
   const availH=Math.max(1,pane.current.clientHeight-parseFloat(pad.paddingTop)-parseFloat(pad.paddingBottom));
   // Shrink to fit a small pane, never enlarge: an upscaled PTY reads as a zoomed-in UI.
   const factor=Math.min(1,availW/width,availH/height);
   mount.current.style.transform=factor===1?'':`scale(${factor})`;
  };
  const connection=runtime;
  const renderer={reset:(cols:number,rows:number)=>{term.reset();term.resize(cols,rows);},write:(bytes:Uint8Array)=>term.write(bytes),state:(s:SessionState)=>{setState(s);if(s.status==='exited')setExitAt(clock(Date.now()/1000,Date.now()/1000));if(s.you!==lastYou||s.cols!==lastCols||s.rows!==lastRows){lastYou=s.you;lastCols=s.cols;lastRows=s.rows;scale();}}};
  const detach=runtime.attach(renderer,{control,live,autoControl});
  const visibility=()=>{const visible=!!pane.current?.clientWidth&&!!pane.current?.clientHeight;runtime.setVisible(renderer,visible);if(visible&&mount.current&&host.parentElement!==mount.current)mount.current.append(host);};
  client.current=connection;
  const keys=(event:KeyboardEvent)=>{if(connection.state.you&&event.ctrlKey&&event.code==='BracketRight'){if(event.type==='keydown')connection.release();event.preventDefault();event.stopPropagation();return false;}
   // A watcher's keys never reach the agent; let Tab move focus out of the terminal.
   if(!connection.state.you&&event.key==='Tab')return false;
   // Nothing a watcher types reaches the agent, so Ctrl combinations go to the app's shortcuts instead of being consumed here.
   if(!connection.state.you&&event.ctrlKey)return false;
   return true;};
  const input=term.onData(data=>{if(host.parentElement===mount.current&&viewRef.current.control&&viewRef.current.live)connection.input(data);});
  const resizer=new ResizeObserver(()=>{visibility();clearTimeout(resizeTimer);resizeTimer=setTimeout(scale,150);});resizer.observe(pane.current);
  term.attachCustomKeyEventHandler(keys);visibility();scale();
  return ()=>{clearTimeout(resizeTimer);resizer.disconnect();observer.disconnect();media.removeEventListener('change',applyTheme);input.dispose();detach();results?.dispose();webLinks.dispose();fileLinks?.dispose();if(host.parentElement===mount.current)host.remove();client.current=undefined;terminal.current=undefined;searchAddon.current=undefined;};
 },[runtime,shell,preview,conversation]);
 useEffect(()=>{if(terminal.current)terminal.current.options.screenReaderMode=reader;},[reader]);
 useLayoutEffect(()=>{onActions?.({find:()=>setFindOpen(true),clear:()=>terminal.current?.clear(),reader:()=>setReader(value=>!value),release:()=>client.current?.release()});return()=>onActions?.(null);},[id]);
 useEffect(()=>{onInputLocked?.(state.status==='live'&&!state.you);},[state.status,state.you,onInputLocked]);
 useLayoutEffect(()=>{if(findOpen) pane.current?.closest('.pc-terminal-view')?.querySelector<HTMLInputElement>('.pc-terminal-search input')?.focus();},[findOpen]);
 // Focus on the next frame, after the control state renders.
 useEffect(()=>{if(!state.you)return;const frame=requestAnimationFrame(()=>{const active=document.activeElement;if(active?.matches("input,textarea")&&!mount.current?.contains(active))return;terminal.current?.focus();});return ()=>cancelAnimationFrame(frame);},[state.you]);
 useEffect(()=>{onControlChange?.(state.you);},[state.you,onControlChange]);
 useEffect(()=>{if(!takeRequested)taken.current=false;},[takeRequested]);
 useEffect(()=>{if(takeRequested&&!taken.current&&state.status==='live'){taken.current=true;void client.current?.take(message=>dialogs.confirm(message,'Take control','Take control')).then(()=>onTakeSent?.()).catch(e=>setError(String(e)));}},[takeRequested,state.status]);
 // ⌘F opens find only when this pane is visible (another tab hides it).
 useEffect(()=>{const onFind=()=>{if(pane.current&&pane.current.offsetParent!==null)setFindOpen(true);};window.addEventListener(FIND_EVENT,onFind);return()=>window.removeEventListener(FIND_EVENT,onFind);},[]);
 const mode=state.status==='exited'?`Exited with code ${state.code ?? 'unknown'}${state.signal?` (${state.signal})`:''}${exitAt?` at ${exitAt}`:''}`:state.you?'You have control':state.status==='live'?'Watching · read-only':state.status==='resyncing'?'Refreshing snapshot…':state.status==='error'?'Session error':state.status==='reconnecting'?'Reconnecting…':'Connecting…';
 const hint=state.you?`Keystrokes go to your ${shell?'shell':'agent'}. Ctrl/⌘-click links; Ctrl-] to release.`:shell?'Nothing you type reaches the shell until you take control.':conversation?'Nothing you type reaches the agent. Closing this window leaves your conversation running.':'Nothing you type reaches the agent.';
 const readerToggle=<label><Checkbox checked={reader} onChange={e=>setReader(e.currentTarget.checked)}/> Screen reader</label>;
 const toggleControl=()=>{if(state.you)client.current?.release();else{void client.current?.take(message=>dialogs.confirm(message,'Take control','Take control')).catch(e=>setError(String(e)));}};
 const reconnect=()=>{if(runtime&&!runtime.disposed)runtime.reconnect();else setAcquisition(n=>n+1);};
 const find=(backward=false)=>{if(!search.trim()){searchAddon.current?.clearDecorations();setSearchFound(null);return;}setSearchFound(backward?searchAddon.current?.findPrevious(search,{caseSensitive,decorations:{matchBackground:getComputedStyle(mount.current!).getPropertyValue('--warn-bg').trim(),activeMatchBackground:getComputedStyle(mount.current!).getPropertyValue('--info-bg').trim(),matchOverviewRuler:getComputedStyle(mount.current!).getPropertyValue('--ink-muted').trim(),activeMatchColorOverviewRuler:getComputedStyle(mount.current!).getPropertyValue('--ink').trim()}})??false:searchAddon.current?.findNext(search,{caseSensitive,decorations:{matchBackground:getComputedStyle(mount.current!).getPropertyValue('--warn-bg').trim(),activeMatchBackground:getComputedStyle(mount.current!).getPropertyValue('--info-bg').trim(),matchOverviewRuler:getComputedStyle(mount.current!).getPropertyValue('--ink-muted').trim(),activeMatchColorOverviewRuler:getComputedStyle(mount.current!).getPropertyValue('--ink').trim()}})??false);};
 return <section className={`pc-terminal-view${footer?' pc-terminal-view--fill':''}`} data-session-control={state.you?'true':'false'} onKeyDownCapture={e=>{if(shell&&(e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='f'){e.preventDefault();e.stopPropagation();setFindOpen(true);}if(shell&&e.key==='Escape'&&findOpen){e.preventDefault();e.stopPropagation();setFindOpen(false);terminal.current?.focus();}}} onKeyDown={e=>{if(state.you)e.stopPropagation();}}
  onPasteCapture={event=>{if(!onFiles)return;const files=filesFromPaste(event);if(files.length){event.preventDefault();event.stopPropagation();const text=event.clipboardData?.getData('text/plain');if(text&&state.you)terminal.current?.paste(text);onFiles(files);}}}
  onDragOver={event=>{if(onFiles)event.preventDefault();}} onDrop={event=>{if(onFiles){event.preventDefault();onFiles(Array.from(event.dataTransfer?.files??[]));}}}>
  {dialogs.dialog}
  {shell&&findOpen&&<div className="pc-terminal-search" role="search" aria-label="Terminal output search">
   <TextInput aria-label="Search terminal output" placeholder="Find" value={search} onInput={event=>{setSearch(event.currentTarget.value);setSearchFound(null);}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();find(event.shiftKey);}}}/>
   <Button size="sm" variant="quiet" aria-label="Match case" aria-pressed={caseSensitive} onClick={()=>setCaseSensitive(value=>!value)}>Aa</Button>
   <IconButton size="sm" variant="quiet" aria-label="Previous" title="Previous match" disabled={!search.trim()} onClick={()=>find(true)}>↑</IconButton>
   <IconButton size="sm" variant="quiet" aria-label="Next" title="Next match" disabled={!search.trim()} onClick={()=>find()}>↓</IconButton>
   <span role="status">{searchFound===false?'No match':`${matches.index} of ${matches.count}`}</span>
   <IconButton size="sm" variant="quiet" aria-label="Close find" title="Close find (Esc)" onClick={()=>{setFindOpen(false);terminal.current?.focus();}}>×</IconButton>
  </div>}
  {shell&&state.status!=='live'&&<div className="pc-terminal-connection" role="status">{mode}{['error','reconnecting'].includes(state.status)&&<Button size="sm" variant="quiet" onClick={reconnect}>Retry</Button>}</div>}
  {shell&&state.status==='live'&&!state.you&&<div className="pc-terminal-connection"><Button size="sm" variant="quiet" onClick={toggleControl}>Take control</Button></div>}

  <div className={`pc-terminal-frame${state.you?' pc-terminal-frame--control':''}${footer?' pc-terminal-frame--fill':''}`}><div className="pc-terminal-pane" ref={pane} tabIndex={preview?0:undefined} role={preview?'region':undefined} aria-label={preview?'Terminal output':undefined}><div ref={mount} className="pc-terminal-mount"/></div>
   {!footer&&!shell&&<div className="pc-terminal-strip"><strong role="status" aria-live="polite">{mode}</strong><span>{hint}</span><span>{state.cols}×{state.rows}</span>{readerToggle}</div>}
  </div>
  {shell?<>{error&&<span role="alert">{error}</span>}</>:footer?createPortal(<div className={`pc-session-control${state.you?' pc-session-control--driving':''}`}>
   <strong className="pc-session-control__mode" role="status" aria-live="polite"><span className="pc-session-control__dot" aria-hidden="true"/><span className="pc-session-control__label" title={mode}>{mode}</span></strong>
   <span className="pc-session-control__hint" title={hint}>{hint}</span>
   {state.message&&<span role="status">{state.message}</span>}{error&&<span role="alert">{error}</span>}
   <span className="grow"/>
   {control&&live&&state.status==='live'&&<Button size="sm" aria-pressed={state.you} title={hint} onClick={toggleControl}>{state.you?'Release control':'Take control'}</Button>}
   {state.status==='error'&&<Button size="sm" onClick={reconnect}>Reconnect</Button>}
   <span className="pc-session-control__size">{state.cols}×{state.rows}</span>{readerToggle}
  </div>,footer):<>
  {state.message&&<p role="status">{state.message}</p>}{error&&<p role="alert">{error}</p>}
  {externalControls&&state.status==='error'&&<Button onClick={reconnect}>Reconnect</Button>}
  {!preview&&!externalControls&&<TerminalControls control={control} live={live} driving={driving} shell={shell} state={state} takeover={takeover} onControl={toggleControl} onReconnect={reconnect}/>}
  </>}
 </section>;
}
export function TerminalControls({control,live,driving,shell,state,takeover,onControl,onReconnect}:{control:boolean;live:boolean;driving?:boolean;shell?:boolean;state:SessionState;takeover?:ComponentChildren;onControl:()=>void;onReconnect?:()=>void}){
 return <div className="pc-session-row">{control&&live&&state.status==='live'&&<Button aria-pressed={state.you} onClick={onControl}>{state.you?(driving?'Hand back':'Release control'):'Take control'}</Button>}
  {takeover}{state.status==='error'&&<Button onClick={onReconnect}>Reconnect</Button>}
  <span className="pc-session-muted">{shell?'Only one window can type into this shell at a time. Closing this page leaves it running.':driving?'Ends this session and sends the task to review':state.you?'Other viewers stay read-only while you hold control.':'Only for agents running interactively. pacer pauses its idle timer while you type.'}</span></div>;
}
export default TerminalView;
