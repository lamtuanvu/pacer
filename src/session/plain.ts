/** Streaming line transcript. Only completed lines are appended, so byte offsets stay valid. */
export class PlainText {
  private decoder = new TextDecoder();
  private state: "text" | "escape" | "csi" | "string" | "stringEscape" = "text";
  private line = "";
  private cr = false;
  private utf8Pending = 0;
  get atBoundary(): boolean { return this.state === "text" && this.utf8Pending === 0; }
  push(data: Uint8Array): string {
    for(const byte of data) {
      if((byte & 0xc0) === 0x80) this.utf8Pending=Math.max(0,this.utf8Pending-1);
      else this.utf8Pending=byte >= 0xf0 && byte <= 0xf4 ? 3 : byte >= 0xe0 && byte <= 0xef ? 2 : byte >= 0xc2 && byte <= 0xdf ? 1 : 0;
    }
    return this.consume(this.decoder.decode(data,{stream:true}));
  }
  private consume(text:string): string {
    let out="";
    for(const ch of text) {
      if(this.state==="escape") { if(ch >= " " && ch <= "/") continue; this.state=ch==="["?"csi":"]PX^_".includes(ch)?"string":"text"; continue; }
      if(this.state==="csi") { if(ch >= "@" && ch <= "~") this.state="text"; continue; }
      if(this.state==="string") { if(ch==="\x07" || ch==="\u009c") this.state="text"; else if(ch==="\x1b") this.state="stringEscape"; continue; }
      if(this.state==="stringEscape") { this.state=ch==="\\"?"text":"string"; continue; }
      if(ch==="\u009b") {this.state="csi";continue;}
      if("\u009d\u0090\u0098\u009e\u009f".includes(ch)) {this.state="string";continue;}
      if(ch==="\x1b") { this.state="escape"; continue; }
      if(ch==="\n") { out+=this.line+"\n"; this.line=""; this.cr=false; continue; }
      if(ch==="\r") { this.cr=true; continue; }
      if(ch==="\b") { this.line=Array.from(this.line).slice(0,-1).join(""); continue; }
      if((ch < " " && ch!=="\t") || ch==="\x7f") continue;
      if(this.cr) { this.line=""; this.cr=false; }
      this.line+=ch;
    }
    return out;
  }
  flush(): string { const out=this.consume(this.decoder.decode())+this.line; this.line=""; return out; }
}
