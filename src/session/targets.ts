import { existsSync } from 'node:fs';
import type { Ctx } from '../types';
import { shq } from '../install/fsx';
export type ViewerTarget='app'|'orca'|'here'|'terminal'|'tmux';
import { TERMINAL_PRESETS } from './terminal-presets';
export { TERMINAL_PRESETS } from './terminal-presets';
export function validateTaskId(id:string){if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw Error('invalid session task id');}
export function attachCommand(id:string){validateTaskId(id);return `pacer attach ${shq(id)}`;}
/** Shell-like quoting for argv only: no substitutions, pipes, redirects or shell execution. */
export function splitArgv(template:string):string[]{
 const out:string[]=[];let word='',quote='',active=false;
 for(let i=0;i<template.length;i++){
  const c=template[i];
  if(c==='\\'&&quote!=="'"){if(++i>=template.length)throw Error('unfinished terminal escape');word+=template[i];active=true;}
  else if(quote){if(c===quote)quote='';else word+=c;}
  else if(c==='"'||c==="'"){quote=c;active=true;}
  else if(/\s/.test(c)){if(active){out.push(word);word='';active=false;}}
  else{word+=c;active=true;}
 }
 if(quote)throw Error('unfinished terminal quote');if(active)out.push(word);return out;
}
export function validateTerminalOpen(value:string){
 if(value==='')return value;
 if(value.length>2000 || /[\x00-\x1f\x7f]/.test(value))throw Error('invalid terminal.open');
 if(!(TERMINAL_PRESETS as readonly string[]).includes(value)&&!value.includes('{cmd}'))throw Error('terminal.open requires a preset or a template with {cmd}');
 splitArgv(value);
 return value;
}
/** AppleScript string literals escape only backslashes and double quotes. */
export function appleScriptString(value:string):string{
 return '"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';
}
export function terminalRecipe(setting:string,id:string,platform:NodeJS.Platform=process.platform):string[]{
 validateTerminalOpen(setting);const command=attachCommand(id),argv=['pacer','attach',id];
 switch(setting){
  case 'ghostty':return platform==='darwin'?['open','-na','Ghostty','--args','-e',...argv]:['ghostty','-e',...argv];
  case 'iterm':return ['osascript','-e',`tell application "iTerm" to create window with default profile command ${appleScriptString(command)}`];
  case 'terminal-app':return ['osascript','-e',`tell application "Terminal" to do script ${appleScriptString(command)}`];
  case 'wezterm':return ['wezterm','start','--',...argv];
  case 'kitty':return ['kitty',...argv];
  case 'alacritty':return ['alacritty','-e',...argv];
  case 'gnome-terminal':return ['gnome-terminal','--',...argv];
  case 'x-terminal-emulator':return ['x-terminal-emulator','-e',...argv];
  default:return splitArgv(setting).flatMap(arg=>arg==='{cmd}'?argv:[arg.replaceAll('{cmd}',command)]);
 }
}
export function hasDesktop(ctx:Ctx,platform:NodeJS.Platform=process.platform):boolean{
 if(ctx.env.SSH_CONNECTION||ctx.env.SSH_CLIENT||ctx.env.SSH_TTY)return false;
 return platform==='darwin'||!!(ctx.env.DISPLAY||ctx.env.WAYLAND_DISPLAY);
}
export function detectTerminal(ctx:Ctx,platform:NodeJS.Platform=process.platform):string|null{
 if(!hasDesktop(ctx,platform))return null;
 const program=(ctx.env.TERM_PROGRAM??'').toLowerCase();
 const names:Record<string,string>={ghostty:'ghostty',iterm:'iterm',itermapp:'iterm','apple_terminal':'terminal-app',wezterm:'wezterm',kitty:'kitty',alacritty:'alacritty'};
 if(names[program])return names[program];
 if(platform==='darwin'){
  for(const [app,preset] of [['Ghostty','ghostty'],['iTerm','iterm'],['Terminal','terminal-app']])if(existsSync(`/Applications/${app}.app`)||existsSync(`/System/Applications/Utilities/${app}.app`))return preset;
 }
 if(!ctx.env.DISPLAY&&!ctx.env.WAYLAND_DISPLAY)return null;
 return ['ghostty','wezterm','kitty','alacritty','gnome-terminal','x-terminal-emulator'].find(bin=>ctx.which(bin))??null;
}
/** GUI terminals may remain in the foreground for the lifetime of the window. */
export async function launchViewer(ctx:Ctx,argv:string[],verifyExit=false):Promise<boolean>{
 try{
  if(verifyExit)return (await ctx.run(argv,15_000,{env:ctx.env})).code===0;
  const proc=Bun.spawn(argv,{env:ctx.env,stdin:'ignore',stdout:'ignore',stderr:'ignore',detached:true});
  const status=await Promise.race([proc.exited,Bun.sleep(100).then(()=>null)]);
  proc.unref();return status===null||status===0;
 }catch{return false;}
}
