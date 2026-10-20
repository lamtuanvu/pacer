import { expect, test } from "bun:test";
import tokens from "../app/src/ds/tokens.json";
import { ROLE_TOKENS, detectTheme, hexTo256, sgr, type Role } from "../src/dashboard/theme";

const token = (name: string, theme: "light" | "dark") => tokens.color.tokens.find(t => t.name === name)!.value[theme];

test("every terminal role resolves to an authored design token in both appearances", () => {
  for (const [role, name] of Object.entries(ROLE_TOKENS)) {
    for (const appearance of ["light", "dark"] as const) {
      const hex = token(name, appearance);
      expect(hex, `${role} → ${name}`).toMatch(/^#[0-9a-f]{6}$/i);
      const theme = detectTheme({ COLORTERM: "truecolor", PACER_THEME: appearance }, true);
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
      expect(sgr(theme, { fg: role as Role }).open).toBe(`\x1b[38;2;${r};${g};${b}m`);
    }
  }
});

test("color depth follows NO_COLOR, TERM, COLORTERM and FORCE_COLOR", () => {
  expect(detectTheme({ NO_COLOR: "" , COLORTERM: "truecolor" }, true).depth).toBe("none");
  expect(detectTheme({ TERM: "dumb" }, true).depth).toBe("none");
  expect(detectTheme({ TERM: "xterm-256color" }, false).depth).toBe("none");
  expect(detectTheme({ TERM: "xterm" }, true).depth).toBe("16");
  expect(detectTheme({ TERM: "xterm-256color" }, true).depth).toBe("256");
  expect(detectTheme({ TERM: "xterm", COLORTERM: "24bit" }, true).depth).toBe("truecolor");
  expect(detectTheme({ TERM: "xterm", FORCE_COLOR: "2" }, false).depth).toBe("256");
  expect(detectTheme({ FORCE_COLOR: "0", COLORTERM: "truecolor" }, true).depth).toBe("none");
  expect(detectTheme({ PACER_COLOR: "16", COLORTERM: "truecolor" }, true).depth).toBe("16");
});

test("appearance, motion and plain mode come from the environment", () => {
  expect(detectTheme({}, true).appearance).toBe("dark");
  expect(detectTheme({ COLORFGBG: "0;15" }, true).appearance).toBe("light");
  expect(detectTheme({ COLORFGBG: "15;0" }, true).appearance).toBe("dark");
  expect(detectTheme({ COLORFGBG: "0;15", PACER_THEME: "dark" }, true).appearance).toBe("dark");
  expect(detectTheme({}, true).motion).toBe(true);
  expect(detectTheme({ PACER_NO_ANIM: "1" }, true).motion).toBe(false);
  const plain = detectTheme({ COLORTERM: "truecolor" }, true, { plain: true });
  expect(plain).toMatchObject({ depth: "none", unicode: false, motion: false, plain: true });
  expect(detectTheme({ LANG: "C" }, true).unicode).toBe(false);
  expect(detectTheme({ LANG: "en_US.UTF-8" }, true).unicode).toBe(true);
});

test("16 and 256 color fallbacks keep status roles distinct and never emit color under NO_COLOR", () => {
  const sixteen = detectTheme({ TERM: "xterm" }, true);
  expect(sgr(sixteen, { fg: "good" }).open).toBe("\x1b[32m");
  expect(sgr(sixteen, { fg: "warn" }).open).toBe("\x1b[33m");
  expect(sgr(sixteen, { fg: "bad" }).open).toBe("\x1b[31m");
  expect(sgr(sixteen, { fg: "info" }).open).toBe("\x1b[36m");
  expect(sgr(sixteen, { fg: "muted" }).open).toBe("\x1b[2m");
  expect(sgr(sixteen, { selected: true }).open).toBe("\x1b[7m");
  const palette = detectTheme({ TERM: "xterm-256color" }, true);
  const codes = (["good", "warn", "bad", "info"] as Role[]).map(role => sgr(palette, { fg: role }).open);
  expect(new Set(codes).size).toBe(4);
  for (const code of codes) expect(code).toMatch(/^\x1b\[38;5;\d+m$/);
  const none = detectTheme({ NO_COLOR: "1" }, true);
  expect(sgr(none, { fg: "bad", bold: true, selected: true })).toEqual({ open: "", close: "" });
});

test("hex to xterm-256 picks the nearest cube or grey entry", () => {
  expect(hexTo256("#000000")).toBe(16);
  expect(hexTo256("#ffffff")).toBe(231);
  expect(hexTo256("#ff0000")).toBe(196);
  expect(hexTo256("#808080")).toBe(244);
});
