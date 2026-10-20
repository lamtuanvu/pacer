import { expect, test } from "bun:test";
import { box, cellWidth, clip, cols, glyph, lineText, lineWidth, meter, paint, rule, span, statusSpans } from "../src/dashboard/frame";
import { detectTheme, PLAIN_THEME, type TerminalTheme } from "../src/dashboard/theme";

const ascii: TerminalTheme = { ...PLAIN_THEME, unicode: false };
const plain = detectTheme({}, true, { plain: true });
const truecolor = detectTheme({ COLORTERM: "truecolor" }, true);

test("cells count wide characters twice and strip control sequences", () => {
  expect(cellWidth("abc")).toBe(3);
  expect(cellWidth("界界")).toBe(4);
  expect(cellWidth("é")).toBe(1);
  expect(cellWidth("a\x1b[7mb")).toBe(5);
  expect(span("bad\x1b[2Jtext").text).toBe("bad[2Jtext");
});

test("clip ends with an ellipsis, respects wide characters and falls back to ASCII", () => {
  expect(clip("longword", 5)).toBe("long…");
  expect(clip("okay", 4)).toBe("okay");
  expect(clip("x", 0)).toBe("");
  expect(clip("界界界", 5)).toBe("界界…");
  expect(clip("longword", 6, "...")).toBe("lon...");
});

test("columns are fixed width, aligned and never exceed the row", () => {
  const line = cols([{ content: "Name that is long", width: 8 }, { content: "42%", width: 5, align: "right" }, { content: "x", width: 3 }]);
  expect(lineText(line)).toBe("Name th…    42%  x  ");
  expect(lineWidth(line)).toBe(8 + 2 + 5 + 2 + 3);
});

test("boxes are closed on every side and degrade to headings in plain mode", () => {
  const body = [[span("first line")], [span("a much longer second line that needs clipping")]];
  const lines = box(PLAIN_THEME, "Done when", body, 24).map(lineText);
  expect(lines).toEqual([
    "╭ Done when ───────────╮",
    "│ first line           │",
    "│ a much longer secon… │",
    "╰──────────────────────╯",
  ]);
  expect(lines.every(l => cellWidth(l) === 24)).toBe(true);
  expect(box(ascii, "Done when", body, 24).map(lineText)[0]).toBe("+ Done when -----------+");
  expect(box(plain, "Done when", body, 24).map(lineText)).toEqual(["DONE WHEN", "  first line", "  a much longer secon..."]);
});

test("meters show fill, track and the pace tick, with an ASCII fallback", () => {
  expect(lineText(meter(PLAIN_THEME, 25, 50, 10, "good"))).toBe("━━━──┃────");
  expect(lineText(meter(ascii, 25, 50, 10, "good"))).toBe("[##--|---]");
  expect(lineText(meter(ascii, 150, -20, 10, "good"))).toBe("[|#######]");
  expect(lineText(meter(PLAIN_THEME, null, null, 6, "neutral"))).toBe("──────");
});

test("status spans always carry a glyph and label; plain mode keeps the label", () => {
  const status = { label: "Waiting for review", tone: "warn" as const, glyph: "◐" };
  expect(lineText(statusSpans(PLAIN_THEME, status))).toBe("◐ Waiting for review");
  expect(lineText(statusSpans(ascii, status))).toBe("o Waiting for review");
  expect(lineText(statusSpans(plain, status))).toBe("Waiting for review");
  expect(glyph(ascii, "✓")).toBe("+");
  expect(glyph(ascii, "✕")).toBe("x");
});

test("painting pads to width, paints selection across the row and resets after each span", () => {
  const out = paint(truecolor, [{ line: [span("ok", { fg: "good" }), span(" text")], selected: true }, { line: rule(truecolor, 4) }], 8);
  const [first, second] = out.split("\n");
  expect(first).toContain("\x1b[38;2;");
  expect(first).toContain("\x1b[48;2;");
  expect(first!.replace(/\x1b\[[0-9;]*m/g, "")).toBe("ok text ");
  expect(second!.replace(/\x1b\[[0-9;]*m/g, "")).toBe("────");
  expect(paint(PLAIN_THEME, [{ line: [span("abc", { fg: "bad", bold: true })], selected: true }], 5)).toBe("abc  ");
});
