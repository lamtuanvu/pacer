import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
export interface Checkpoint { generation: number; outputOffset: number; cols: number; rows: number; scrollbackAnsi: string; screenAnsi: string; modes: Record<string, unknown> }
export class Screen {
  readonly term: Terminal;
  private addon = new SerializeAddon();
  outputOffset = 0;
  generation = 0;
  constructor(cols = 120, rows = 40) {
    this.term = new Terminal({cols,rows,scrollback:5000,allowProposedApi:true}); this.term.loadAddon(this.addon);
  }
  async output(data: Uint8Array): Promise<void> {
    await new Promise<void>(resolve => this.term.write(data, resolve)); this.outputOffset += data.length;
  }
  resize(cols:number,rows:number) { this.term.resize(cols,rows); }
  plain(): string {
    const b = this.term.buffer.active, lines: string[] = [];
    for (let i=0; i <= b.baseY + b.cursorY; i++) {
      const line = b.getLine(i); if (!line) continue;
      if (line.isWrapped && lines.length) lines[lines.length-1] += line.translateToString(true);
      else lines.push(line.translateToString(true));
    }
    return lines.join("\n");
  }
  snapshot(): Checkpoint {
    return {generation:this.generation,outputOffset:this.outputOffset,cols:this.term.cols,rows:this.term.rows,scrollbackAnsi:"",screenAnsi:this.addon.serialize(),modes:{}};
  }
  async restore(c: Checkpoint) {
    this.resize(c.cols,c.rows); await this.output(Buffer.from(c.scrollbackAnsi+c.screenAnsi)); this.generation=c.generation; this.outputOffset=c.outputOffset;
  }
  dispose() { this.term.dispose(); }
}
