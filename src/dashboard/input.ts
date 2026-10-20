export type Key = "up" | "down" | "left" | "right" | "enter" | "escape" | "backspace" | "interrupt" | "tab" | "backtab" | "pageup" | "pagedown" | "home" | "end" | string;

const SEQUENCES: [string, Key][] = [
  ["\x1b[A", "up"], ["\x1b[B", "down"], ["\x1b[C", "right"], ["\x1b[D", "left"],
  ["\x1bOA", "up"], ["\x1bOB", "down"], ["\x1bOC", "right"], ["\x1bOD", "left"],
  ["\x1b[Z", "backtab"], ["\x1b[5~", "pageup"], ["\x1b[6~", "pagedown"],
  ["\x1b[H", "home"], ["\x1b[F", "end"], ["\x1b[1~", "home"], ["\x1b[4~", "end"], ["\x1bOH", "home"], ["\x1bOF", "end"],
];
/** Escape sequences that may still be arriving in a later chunk. */
const isPrefix = (text: string) => SEQUENCES.some(([seq]) => seq.startsWith(text) && seq !== text);

/** Keep split escape sequences and UTF-8 input intact across terminal chunks. */
export class Keys {
  private pending = "";
  feed(text: string): Key[] {
    this.pending += text;
    const out: Key[] = [];
    while (this.pending) {
      if (isPrefix(this.pending)) break;
      const sequence = SEQUENCES.find(([seq]) => this.pending.startsWith(seq));
      if (sequence) { out.push(sequence[1]); this.pending = this.pending.slice(sequence[0].length); continue; }
      const char = Array.from(this.pending)[0]!;
      this.pending = this.pending.slice(char.length);
      out.push(char === "\x03" ? "interrupt" : char === "\r" || char === "\n" ? "enter" : char === "\x7f" || char === "\b" ? "backspace" : char === "\t" ? "tab" : char === "\x1b" ? "escape" : char);
    }
    return out;
  }
  /** A lone escape after a pause is the Escape key. */
  flush(): Key[] {
    const text = this.pending;
    this.pending = "";
    return text === "\x1b" ? ["escape"] : [];
  }
}
