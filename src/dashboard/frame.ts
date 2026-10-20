/** Terminal layout primitives: cells, spans, columns, boxes, meters and painting. Pure and theme-driven. */
import type { Status, StatusTone } from "../view-model/words";
import { sgr, type Role, type Style, type TerminalTheme } from "./theme";

export interface Span { text: string; style?: Style }
export type Line = Span[];
export interface PaintRow { line: Line; selected?: boolean }

/** Untrusted text (titles, reasons, prompts) never carries control sequences into the frame. */
export const safeText = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

function charWidth(char: string): number {
  const cp = char.codePointAt(0)!;
  if (/\p{Mark}/u.test(char)) return 0;
  const wide = cp >= 0x1100 && (cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7af
    || cp >= 0xf900 && cp <= 0xfaff || cp >= 0xfe10 && cp <= 0xfe6f || cp >= 0xff01 && cp <= 0xff60 || cp >= 0x1f300);
  return wide ? 2 : 1;
}
/** Width in terminal cells, rather than UTF-16 code units. */
export function cellWidth(text: string): number {
  let width = 0;
  for (const char of safeText(text)) width += charWidth(char);
  return width;
}
/** Shortened text always ends in an ellipsis (UI-11: the full text stays reachable in the detail view). */
export function clip(text: string, width: number, ellipsis = "…"): string {
  text = safeText(text);
  width = Math.max(0, Math.floor(width));
  if (cellWidth(text) <= width) return text;
  const room = width - cellWidth(ellipsis);
  if (room < 0) return width > 0 ? ".".repeat(width) : "";
  let result = "", cells = 0;
  for (const char of text) {
    const size = charWidth(char);
    if (cells + size > room) break;
    result += char;
    cells += size;
  }
  return result.trimEnd() + ellipsis;
}

export const span = (text: string, style?: Style): Span => ({ text: safeText(text), ...(style ? { style } : {}) });
export const lineText = (line: Line) => line.map(s => s.text).join("");
export const lineWidth = (line: Line) => line.reduce((n, s) => n + cellWidth(s.text), 0);
const ellipsisFor = (theme?: TerminalTheme) => theme && !theme.unicode ? "..." : "…";

/** Clip a styled line to a width, keeping span styles. */
export function fit(line: Line, width: number, theme?: TerminalTheme): Line {
  if (lineWidth(line) <= width) return line;
  // The line overflows: keep whole spans while a cell remains for the ellipsis, then clip the next one.
  const out: Line = [];
  let remaining = width;
  for (const s of line) {
    if (remaining <= 0) break;
    const size = cellWidth(s.text);
    if (size < remaining) { out.push(s); remaining -= size; continue; }
    const text = clip(s.text.padEnd(s.text.length + 1, " "), remaining, ellipsisFor(theme));
    out.push({ ...s, text });
    break;
  }
  return out;
}
export function pad(line: Line, width: number, theme?: TerminalTheme): Line {
  const fitted = fit(line, width, theme), gap = width - lineWidth(fitted);
  return gap > 0 ? [...fitted, span(" ".repeat(gap))] : fitted;
}
const asSpans = (content: string | Line, style?: Style): Line => typeof content === "string" ? [span(content, style)] : content;

export interface Col { content: string | Line; width: number; align?: "left" | "right"; style?: Style }
/** A row of fixed-width columns separated by `gap` cells (spacing token space-2/space-3). */
export function cols(columns: Col[], gap = 2, theme?: TerminalTheme): Line {
  const out: Line = [];
  columns.forEach((col, i) => {
    if (i > 0 && gap > 0) out.push(span(" ".repeat(gap)));
    const fitted = fit(asSpans(col.content, col.style), col.width, theme), room = col.width - lineWidth(fitted);
    if (col.align === "right" && room > 0) out.push(span(" ".repeat(room)), ...fitted);
    else out.push(...fitted, ...(room > 0 ? [span(" ".repeat(room))] : []));
  });
  return out;
}
/** Split `total` cells among columns: fixed widths first, then flex weights. Columns with width 0 are dropped by callers. */
export function flex(total: number, specs: ({ fixed: number } | { weight: number; min?: number })[], gap = 2): number[] {
  const visible = specs.length, gaps = Math.max(0, visible - 1) * gap;
  const fixed = specs.reduce((n, s) => n + ("fixed" in s ? s.fixed : 0), 0);
  const weights = specs.reduce((n, s) => n + ("weight" in s ? s.weight : 0), 0);
  const free = Math.max(0, total - fixed - gaps);
  const widths = specs.map(s => "fixed" in s ? s.fixed : Math.max(s.min ?? 0, Math.floor(free * s.weight / Math.max(1, weights))));
  const used = widths.reduce((a, b) => a + b, 0) + gaps;
  const lastFlex = specs.map((s, i) => ("weight" in s ? i : -1)).filter(i => i >= 0).at(-1);
  if (lastFlex !== undefined) widths[lastFlex] = Math.max(0, widths[lastFlex]! + total - used);
  return widths;
}

const ASCII: Record<string, string> = {
  "✓": "+", "✕": "x", "▶": ">", "…": "~", "■": "=", "◐": "o", "↓": "v", "↑": "^", "∞": "*", "●": "*", "○": "o",
  "›": ">", "‹": "<", "▸": ">", "·": "-", "→": "->", "⏎": "Enter", "━": "#", "─": "-", "┃": "|", "│": "|", "▬┃": "=|",
};
/** A Unicode glyph, or its ASCII stand-in. Labels always accompany glyphs, so the stand-ins only aid scanning. */
export const glyph = (theme: TerminalTheme, g: string) => theme.unicode ? g : ASCII[g] ?? g;

export const toneRole = (tone: StatusTone): Role => tone === "neutral" ? "muted" : tone;
/** Glyph + label in the status tone (UI-2, UI-10). Plain mode keeps only the label. */
export function statusSpans(theme: TerminalTheme, status: Status, extra: Style = {}): Line {
  const style: Style = { fg: toneRole(status.tone), ...extra };
  return theme.plain ? [span(status.label, style)] : [span(`${glyph(theme, status.glyph)} ${status.label}`, style)];
}
/** The one section-heading style: uppercase label in muted bold, then its count (UI-9). */
export function heading(theme: TerminalTheme, label: string, count?: string | number, note?: string, separator = true): Line {
  const out: Line = [span(label.toUpperCase(), { fg: "muted", bold: true })];
  if (count !== undefined) out.push(span("  "), span(String(count), { fg: "ink", bold: true }));
  if (note) out.push(span(separator ? ` ${glyph(theme, "·")} ${note}` : ` ${note}`, { fg: "muted" }));
  return out;
}
export const rule = (theme: TerminalTheme, width: number): Line => [span(glyph(theme, "─").repeat(Math.max(0, width)), { fg: "line" })];

/** A closed box (radius-lg card). Plain mode uses a heading and an indented body instead of borders. */
export function box(theme: TerminalTheme, title: string | undefined, body: Line[], width: number): Line[] {
  if (theme.plain) return [...(title ? [[span(title.toUpperCase(), { bold: true })]] : []), ...body.map(line => [span("  "), ...fit(line, width - 2, theme)])];
  const [tl, tr, bl, br, h, v] = theme.unicode ? ["╭", "╮", "╰", "╯", "─", "│"] : ["+", "+", "+", "+", "-", "|"];
  const border = { fg: "line" as const };
  const inner = Math.max(0, width - 2);
  const label = title ? clip(` ${title} `, inner, ellipsisFor(theme)) : "";
  const top: Line = [span(tl, border), ...(label ? [span(label, { fg: "ink", bold: true })] : []), span(h!.repeat(Math.max(0, inner - cellWidth(label))), border), span(tr, border)];
  const rows = body.map(line => [span(`${v} `, border), ...pad(line, Math.max(0, width - 4), theme), span(` ${v}`, border)]);
  return [top, ...rows, [span(bl + h!.repeat(inner) + br, border)]];
}

/** UsageMeter: fill in the pace tone, track in `line`, pace tick in bold ink. ASCII: [##--|---]. */
export function meter(theme: TerminalTheme, used: number | null, pace: number | null, size: number, tone: StatusTone): Line {
  const ascii = !theme.unicode, inner = Math.max(1, ascii ? size - 2 : size);
  const pct = (n: number) => Math.max(0, Math.min(100, n));
  const filled = used === null ? 0 : Math.round(pct(used) * inner / 100);
  const tick = pace === null ? -1 : Math.min(inner - 1, Math.floor(pct(pace) * inner / 100));
  const fillRole: Role = tone === "neutral" ? "muted" : tone;
  const out: Line = [];
  const push = (text: string, style: Style) => {
    const last = out.at(-1);
    if (last && last.style?.fg === style.fg && last.style?.bold === style.bold) last.text += text;
    else out.push({ text, style });
  };
  if (ascii) out.push(span("["));
  for (let i = 0; i < inner; i++) {
    if (i === tick) push(ascii ? "|" : "┃", { fg: "ink", bold: true });
    else if (i < filled) push(ascii ? "#" : "━", { fg: fillRole });
    else push(ascii ? "-" : "─", { fg: "line" });
  }
  if (ascii) out.push(span("]"));
  return out;
}

/** Width-preserving, so layout computed before painting still holds. */
const TRANSLIT: [RegExp, string][] = [[/·/g, "-"], [/…/g, "."], [/[—–]/g, "-"], [/→/g, ">"], [/×/g, "x"], [/›/g, ">"], [/⏎/g, "#"], [/[“”]/g, '"'], [/[‘’]/g, "'"]];
/** ASCII terminals get ASCII text, including punctuation from shared copy. */
export function ascii(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TRANSLIT) out = out.replace(pattern, replacement);
  return out;
}

/** Turn rows into terminal text. Selected rows are padded so the selection background spans the row. */
export function paint(theme: TerminalTheme, rows: PaintRow[], width: number): string {
  return rows.map(({ line, selected }) => {
    if (!theme.unicode) line = line.map(s => ({ ...s, text: ascii(s.text) }));
    const fitted = selected ? pad(line, width, theme) : fit(line, width, theme);
    return fitted.map(s => {
      const { open, close } = sgr(theme, { ...s.style, ...(selected ? { selected: true } : {}) });
      return open ? `${open}${s.text}${close}` : s.text;
    }).join("");
  }).join("\n");
}

/** Word-wrap prose to a width. A token wider than the line is clipped, never broken mid-token (UI-11). */
export function wrap(text: string, width: number, maxLines = Infinity): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of safeText(paragraph).split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (cellWidth(candidate) <= width) { line = candidate; continue; }
      if (line) lines.push(line);
      line = cellWidth(word) > width ? clip(word, width) : word;
    }
    lines.push(line);
  }
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), clip(lines.slice(maxLines - 1).join(" "), width)];
}
