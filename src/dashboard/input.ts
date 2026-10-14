export type Key = "up"|"down"|"enter"|"escape"|"backspace"|"interrupt"|string;
/** Keep split escape sequences and UTF-8 input intact across terminal chunks. */
export class Keys {
 private pending="";
 feed(text:string):Key[] {
  this.pending+=text;const out:Key[]=[];
  while(this.pending) {
   if(this.pending==="\x1b"||this.pending==="\x1b[")break;
   if(this.pending.startsWith("\x1b[A")||this.pending.startsWith("\x1b[B")){out.push(this.pending[2]==="A"?"up":"down");this.pending=this.pending.slice(3);continue;}
   const char=Array.from(this.pending)[0];this.pending=this.pending.slice(char.length);
   out.push(char==="\x03"?"interrupt":char==="\r"||char==="\n"?"enter":char==="\x7f"?"backspace":char==="\x1b"?"escape":char);
  }return out;
 }
 flush():Key[] {const text=this.pending;this.pending="";return text==="\x1b"?["escape"]:[];}
}

import type { Card } from "./model";
import type { CmdData } from "../link/envelope";
export function selectionAction(key:Key,card?:Card):CmdData|undefined {
 if(key==="enter")return card?.action;
 if(key==="x")return card?.dismiss;
 if(key==="b"&&card?.provider)return {cmd:card.provider.blockedReason?"unblock":"block",executor:card.provider.id};
}
export function moveSelection(key:Key,selected:number,count:number):number {
 return key==="up"||key==="k"?Math.max(0,selected-1):key==="down"||key==="j"?Math.min(Math.max(0,count-1),selected+1):selected;
}
