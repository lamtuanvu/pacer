import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
export interface Checkpoint { generation: number; outputOffset: number; cols: number; rows: number; scrollbackAnsi: string; screenAnsi: string; modes: Record<string, unknown> }
export class Screen {
  readonly term: Terminal;
  private addon = new SerializeAddon();
  /** SerializeAddon 0.14 omits DECTCEM; track via public CSI handlers. */
  private cursorVisible = true;
  private scrollTop = 0;
  private scrollBottom: number;
  outputOffset = 0;
  generation = 0;
  constructor(cols = 120, rows = 40) {
    this.term = new Terminal({cols,rows,scrollback:5000,allowProposedApi:true}); this.term.loadAddon(this.addon);
    this.scrollBottom = rows - 1;
    this.observePrivateModes();
  }
  /** Observe modes the public SerializeAddon cannot round-trip (DECTCEM, DECSTBM). */
  private observePrivateModes() {
    for (const final of ["h", "l"] as const) {
      this.term.parser.registerCsiHandler({prefix:"?",final}, params => {
        if (params.includes(25)) this.cursorVisible = final === "h";
        return false;
      });
    }
    this.term.parser.registerCsiHandler({final:"r"}, params => {
      const top = Number(params[0] || 1) - 1;
      const bottom = Number(params[1] || this.term.rows) - 1;
      if (top >= 0 && top < bottom && bottom < this.term.rows) {
        this.scrollTop = top;
        this.scrollBottom = bottom;
      }
      return false;
    });
    const resetMargins = () => {
      this.cursorVisible = true;
      this.scrollTop = 0;
      this.scrollBottom = this.term.rows - 1;
      return false;
    };
    this.term.parser.registerEscHandler({final:"c"}, resetMargins);
    this.term.parser.registerCsiHandler({intermediates:"!",final:"p"}, resetMargins);
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
    // SerializeAddon emits DECOM after cursor restore (homing the cursor) and
    // never emits DECTCEM. Patch both into screenAnsi so restore/replay match.
    let screenAnsi = this.addon.serialize();
    if (this.term.modes.originMode) {
      const buffer = this.term.buffer.active;
      screenAnsi += `\x1b[?6l\x1b[${this.scrollTop+1};${this.scrollBottom+1}r\x1b[?6h`;
      screenAnsi += `\x1b[${buffer.cursorY-this.scrollTop+1};${buffer.cursorX+1}H`;
    }
    if (!this.cursorVisible) screenAnsi += "\x1b[?25l";
    return {generation:this.generation,outputOffset:this.outputOffset,cols:this.term.cols,rows:this.term.rows,scrollbackAnsi:"",screenAnsi,modes:{}};
  }
  async restore(c: Checkpoint) {
    this.resize(c.cols,c.rows); await this.output(Buffer.from(c.scrollbackAnsi+c.screenAnsi)); this.generation=c.generation; this.outputOffset=c.outputOffset;
  }
  dispose() { this.term.dispose(); }
}
