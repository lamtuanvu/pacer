import { expect, test } from "bun:test";
import { allowsNativeContextMenu, attachContextMenuPolicy } from "../app/src/shell/context-menu";

type NodeLike = { tagName?: string; className?: string; isContentEditable?: boolean; type?: string; role?: string; closest?: (sel: string) => unknown };
/** A duck-typed DOM node: `closest` realises the relevant selector shapes so tests need no real DOM. */
function el(props: { tag?: string; cls?: string; editable?: boolean; type?: string; role?: string }): NodeLike {
  const tag = props.tag ?? "div", cls = props.cls ?? "", role = props.role;
  const node: NodeLike = { tagName: tag.toUpperCase(), className: cls, isContentEditable: props.editable, type: props.type, role };
  node.closest = (sel: string) => {
    const hit = sel.split(",").some(part => {
      const s = part.trim();
      if (s.startsWith(".")) return cls.split(/\s+/).includes(s.slice(1));
      if (s.startsWith("[role=")) return role !== undefined && role === s.slice(6, -1);
      return s.toLowerCase() === tag.toLowerCase();
    });
    return hit ? node : null;
  };
  return node;
}
/** A target whose `closest` reports it inside no matching ancestor. */
const plainContent = { tagName: "DIV", closest: () => null };

test("a button inside chrome (e.g. .pc-rail) is suppressed", () => {
  expect(allowsNativeContextMenu(el({ tag: "button", cls: "pc-rail" }))).toBe(false);
});
test("a text input inside chrome keeps the native menu", () => {
  expect(allowsNativeContextMenu(el({ tag: "input", type: "text", cls: "pc-topbar" }))).toBe(true);
});
test("a textarea keeps the native menu", () => {
  expect(allowsNativeContextMenu(el({ tag: "textarea" }))).toBe(true);
});
test("an element inside the terminal (.xterm) keeps the native menu", () => {
  expect(allowsNativeContextMenu(el({ tag: "div", cls: "xterm" }))).toBe(true);
});
test("code inside chrome keeps the native menu", () => {
  expect(allowsNativeContextMenu(el({ tag: "code", cls: "pc-pill" }))).toBe(true);
});
test("plain content is allowed", () => {
  expect(allowsNativeContextMenu(plainContent)).toBe(true);
});
test("a chrome button with an active selection is allowed", () => {
  expect(allowsNativeContextMenu(el({ tag: "button", cls: "pc-rail" }), "abc")).toBe(true);
});
test("an unknown target never breaks the default", () => {
  expect(allowsNativeContextMenu(null)).toBe(true);
});
test("attachContextMenuPolicy suppresses the context menu only on chrome", () => {
  let handler: ((event: { target?: unknown; preventDefault: () => void }) => void) | undefined;
  const fakeWindow = {
    addEventListener: (_type: string, fn: typeof handler) => { handler = fn; },
    removeEventListener: (_type: string, _fn: typeof handler) => { handler = undefined; },
  } as unknown as Window;
  const off = attachContextMenuPolicy(fakeWindow);
  const chrome = el({ tag: "button", cls: "pc-rail" });
  const chromeEvent = { target: chrome, prevented: false, preventDefault() { this.prevented = true; } };
  handler?.(chromeEvent);
  expect(chromeEvent.prevented).toBe(true);
  const contentEvent = { target: plainContent, prevented: false, preventDefault() { this.prevented = true; } };
  handler?.(contentEvent);
  expect(contentEvent.prevented).toBe(false);
  off();
  expect(handler).toBeUndefined();
});
