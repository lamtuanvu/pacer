/**
 * Terminal rendition of the design system (app/src/ds/tokens.json).
 * The TUI shares the token values and status semantics, never Preact components (UI-20).
 */
import tokens from "../../app/src/ds/tokens.json";
import { agentKey } from "../view-model/agents";

export type ColorDepth = "none" | "16" | "256" | "truecolor";
export type Appearance = "light" | "dark";
/** Semantic roles. Status roles carry meaning only together with a glyph and label (UI-2). */
export type Role = "ink" | "secondary" | "muted" | "line" | "good" | "warn" | "bad" | "info" | "accent" | "focus";
export interface TerminalTheme {
  depth: ColorDepth;
  appearance: Appearance;
  /** Box drawing, meters and status glyphs; false falls back to ASCII. */
  unicode: boolean;
  /** PACER_NO_ANIM or plain mode freeze spinners and the live pulse. */
  motion: boolean;
  /** Screen-reader friendly: ASCII, no color, no borders, labels before values. */
  plain: boolean;
}
export interface Style { fg?: Role; agent?: string; bold?: boolean; underline?: boolean; selected?: boolean }

/** Role → authored token. Foreground status roles use the pill text tokens, which meet 4.5:1 on the page surface. */
export const ROLE_TOKENS: Record<Role, string> = {
  ink: "ink", secondary: "ink-secondary", muted: "ink-muted", line: "line",
  good: "good-fg", warn: "warn-fg", bad: "bad-fg", info: "info-fg",
  accent: "track", focus: "focus",
};
const SELECTION_TOKEN = "surface-lane";
/** 16-color fallbacks use the terminal's own palette, so they follow its light or dark scheme. */
const ANSI16: Record<Role, string> = {
  ink: "", secondary: "", muted: "2", line: "2", good: "32", warn: "33", bad: "31", info: "36", accent: "", focus: "34",
};

type Hex = string;
const colors = new Map<string, Record<Appearance, Hex>>(
  tokens.color.tokens.map(t => [t.name, t.value as Record<Appearance, Hex>]),
);
function tokenHex(name: string, appearance: Appearance): Hex | undefined {
  const value = colors.get(name)?.[appearance];
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
}
const rgb = (hex: Hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

const CUBE = [0, 95, 135, 175, 215, 255];
/** Nearest xterm-256 index, from the 6×6×6 cube or the grey ramp. */
export function hexTo256(hex: Hex): number {
  const [r, g, b] = rgb(hex);
  const nearest = (v: number) => CUBE.reduce((best, level, i) => Math.abs(level - v) < Math.abs(CUBE[best]! - v) ? i : best, 0);
  const [ri, gi, bi] = [nearest(r), nearest(g), nearest(b)];
  const cube = [CUBE[ri]!, CUBE[gi]!, CUBE[bi]!];
  const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const greyValue = 8 + grey * 10;
  const distance = (c: number[]) => (c[0]! - r) ** 2 + (c[1]! - g) ** 2 + (c[2]! - b) ** 2;
  return distance([greyValue, greyValue, greyValue]) < distance(cube) ? 232 + grey : 16 + 36 * ri + 6 * gi + bi;
}

function colorCode(theme: TerminalTheme, hex: Hex, layer: "fg" | "bg"): string {
  const base = layer === "fg" ? 38 : 48;
  if (theme.depth === "truecolor") { const [r, g, b] = rgb(hex); return `\x1b[${base};2;${r};${g};${b}m`; }
  return `\x1b[${base};5;${hexTo256(hex)}m`;
}

/** Agent identity colour from the shared descriptors; ink agents use the ink role. */
export function agentToken(agent: string): string | undefined {
  const key = agentKey(agent);
  return key && colors.has(`agent-${key}`) ? `agent-${key}` : undefined;
}

export function sgr(theme: TerminalTheme, style: Style): { open: string; close: string } {
  if (theme.depth === "none") return { open: "", close: "" };
  let open = "";
  if (style.bold) open += "\x1b[1m";
  if (style.underline) open += "\x1b[4m";
  if (theme.depth === "16") {
    const code = style.fg ? ANSI16[style.fg] : "";
    if (code) open += `\x1b[${code}m`;
    if (style.selected) open += "\x1b[7m";
  } else {
    const agent = style.agent ? agentToken(style.agent) : undefined;
    const fg = agent ? tokenHex(agent, theme.appearance) : style.fg ? tokenHex(ROLE_TOKENS[style.fg], theme.appearance) : undefined;
    if (fg) open += colorCode(theme, fg, "fg");
    if (style.selected) open += colorCode(theme, tokenHex(SELECTION_TOKEN, theme.appearance)!, "bg");
  }
  return open ? { open, close: "\x1b[0m" } : { open: "", close: "" };
}

const DEPTHS: Record<string, ColorDepth> = { none: "none", "16": "16", "256": "256", truecolor: "truecolor" };
type Env = Record<string, string | undefined>;
function depthFrom(env: Env, isTTY: boolean): ColorDepth {
  if (env.NO_COLOR !== undefined) return "none";
  const forced = env.PACER_COLOR && DEPTHS[env.PACER_COLOR];
  if (forced) return forced;
  if (env.FORCE_COLOR !== undefined) {
    const level = env.FORCE_COLOR === "" || env.FORCE_COLOR === "true" ? 1 : Number(env.FORCE_COLOR);
    if (level === 0) return "none";
    if (level >= 1) return level >= 3 ? "truecolor" : level === 2 ? "256" : "16";
  }
  if (!isTTY || env.TERM === "dumb") return "none";
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) return "truecolor";
  return /256/.test(env.TERM ?? "") ? "256" : "16";
}
function appearanceFrom(env: Env): Appearance {
  if (env.PACER_THEME === "light" || env.PACER_THEME === "dark") return env.PACER_THEME;
  const bg = Number(env.COLORFGBG?.split(";").at(-1));
  return bg === 7 || bg === 15 ? "light" : "dark";
}
function unicodeFrom(env: Env): boolean {
  if (env.PACER_ASCII === "1") return false;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  return locale === undefined || locale === "" || /utf-?8/i.test(locale);
}

/** Detect once at start-up; tests pass explicit env so frames never depend on the host terminal. */
export function detectTheme(env: Env, isTTY: boolean, options: { plain?: boolean } = {}): TerminalTheme {
  const plain = options.plain === true || env.PACER_PLAIN === "1";
  if (plain) return { depth: "none", appearance: appearanceFrom(env), unicode: false, motion: false, plain: true };
  return { depth: depthFrom(env, isTTY), appearance: appearanceFrom(env), unicode: unicodeFrom(env), motion: env.PACER_NO_ANIM === undefined, plain: false };
}

/** A fixed theme for golden frames. */
export const PLAIN_THEME: TerminalTheme = { depth: "none", appearance: "dark", unicode: true, motion: false, plain: false };
