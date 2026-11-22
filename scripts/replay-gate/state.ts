import type { Terminal } from "@xterm/headless";

/**
 * Canonical terminal state encoding for the replay gate (schema 2).
 *
 * A screen row is RLE-encoded as a list of runs. Each run describes a
 * contiguous group of cells with identical text and attributes.
 *
 * run = [count, chars, width, fgMode, fg, bgMode, bg, flags]
 *   count   number of cells in the run
 *   chars   the cell text (may be empty or multi-width)
 *   width   cell width from xterm's Unicode table (1 for wide chars)
 *   fgMode  xterm color mode number: 0, 16777216 (P16), 33554432 (P256), 50331648 (RGB)
 *   fg      the fg palette index / RGB value
 *   bgMode  xterm color mode number (as fgMode)
 *   bg      the bg palette index / RGB value
 *   flags   bits 0..8 = bold, italic, dim, underline, blink, inverse, invisible, strikethrough, overline
 */
export type Run = [count: number, chars: string, width: number, fgMode: number, fg: number, bgMode: number, bg: number, flags: number];
/** row = [isWrapped, runs] */
export type Row = [isWrapped: boolean, runs: Run[]];

export interface GateState {
  cursorVisible: boolean;
  type: "normal" | "alternate";
  cursorX: number;
  cursorY: number;
  baseY: number;
  viewportY: number;
  scrollTop: number;
  scrollBottom: number;
  /** exactly the keys of @xterm/headless 6.0.0 `term.modes` */
  modes: Record<string, unknown>;
  rows: Row[];
}

/** Accumulate per-cell flags into the bit-packed `flags` field. */
function cellFlags(cell: ReturnType<NonNullable<ReturnType<Terminal["buffer"]["active"]["getLine"]>>["getCell"]>): number {
  let flags = 0;
  if (cell?.isBold()) flags |= 1 << 0;
  if (cell?.isItalic()) flags |= 1 << 1;
  if (cell?.isDim()) flags |= 1 << 2;
  if (cell?.isUnderline()) flags |= 1 << 3;
  if (cell?.isBlink()) flags |= 1 << 4;
  if (cell?.isInverse()) flags |= 1 << 5;
  if (cell?.isInvisible()) flags |= 1 << 6;
  if (cell?.isStrikethrough()) flags |= 1 << 7;
  if (cell?.isOverline()) flags |= 1 << 8;
  return flags;
}

/**
 * Read a terminal's full (scrollback + active) screen as a `GateState`.
 * `cursorVisible`, `scrollTop` and `scrollBottom` are observed externally
 * because DECTCEM and DECSTBM are not part of `term.modes`.
 */
export function terminalState(
  term: Terminal,
  cursorVisible: boolean,
  scrollTop: number,
  scrollBottom: number,
): GateState {
  const buffer = term.buffer.active;
  const rows: Row[] = [];
  for (let index = 0; index < buffer.length; index++) {
    const line = buffer.getLine(index);
    const runs: Run[] = [];
    if (line) {
      for (let col = 0; col < term.cols; col++) {
        const cell = line.getCell(col);
        const chars = cell?.getChars() ?? "";
        const width = cell?.getWidth() ?? 0;
        const fgMode = cell?.getFgColorMode() ?? 0;
        const fg = cell?.getFgColor() ?? 0;
        const bgMode = cell?.getBgColorMode() ?? 0;
        const bg = cell?.getBgColor() ?? 0;
        const flags = cellFlags(cell);
        const last = runs[runs.length - 1];
        if (last && last[1] === chars && last[2] === width && last[3] === fgMode && last[4] === fg &&
            last[5] === bgMode && last[6] === bg && last[7] === flags) {
          last[0] += 1;
        } else {
          runs.push([1, chars, width, fgMode, fg, bgMode, bg, flags]);
        }
      }
    }
    rows.push([line?.isWrapped ?? false, runs]);
  }
  return {
    cursorVisible,
    type: buffer.type,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    baseY: buffer.baseY,
    viewportY: buffer.viewportY,
    scrollTop,
    scrollBottom,
    modes: { ...term.modes },
    rows,
  };
}