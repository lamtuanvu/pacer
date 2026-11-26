// A minimal fake DOM so preact's hooks and event handlers run under bun:test (no browser).
export type FakeElement = {
  nodeType: number; tagName: string; childNodes: FakeElement[]; parentNode: FakeElement | null;
  data?: string; attrs: Record<string, string>; _listeners: Record<string, (event?: unknown) => void>;
  addEventListener: (type: string, fn: (event?: unknown) => void) => void; removeEventListener: (type: string) => void;
  setAttribute: (name: string, value: unknown) => void; getAttribute: (name: string) => string | null; removeAttribute: (name: string) => void;
  appendChild: (child: FakeElement) => FakeElement; insertBefore: (child: FakeElement, before: FakeElement | null) => FakeElement;
  removeChild: (child: FakeElement) => FakeElement; focus: () => void; querySelector: () => null; querySelectorAll: () => FakeElement[];
};
const insert = (parent: FakeElement, child: FakeElement, before: FakeElement | null) => {
  if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter(c => c !== child);
  const at = before ? parent.childNodes.indexOf(before) : -1;
  if (at < 0) parent.childNodes.push(child); else parent.childNodes.splice(at, 0, child);
  child.parentNode = parent;
};
export const fakeElement = (tag: string): FakeElement => {
  const node: FakeElement = {
    nodeType: 1, tagName: tag, childNodes: [], parentNode: null, attrs: {}, _listeners: {},
    addEventListener(type, fn) { node._listeners[type] = fn; },
    removeEventListener(type) { delete node._listeners[type]; },
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) { return name in node.attrs ? node.attrs[name]! : null; },
    removeAttribute(name) { delete node.attrs[name]; },
    appendChild(child) { insert(node, child, null); return child; },
    insertBefore(child, before) { insert(node, child, before); return child; },
    removeChild(child) { node.childNodes = node.childNodes.filter(c => c !== child); child.parentNode = null; return child; },
    focus() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  };
  return node;
};
/** Install the fake globals for one test; the returned function restores the previous ones. */
export function installFakeDom(): () => void {
  const g = globalThis as Record<string, unknown>;
  const keys = ["document", "window", "CSSStyleSheet", "getComputedStyle", "requestAnimationFrame"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, g[key]]));
  g.document = {
    adoptedStyleSheets: [], createElement: (t: string) => fakeElement(t), createElementNS: (_ns: string, t: string) => fakeElement(t),
    createTextNode: (t: string) => { const n = fakeElement("#text"); n.nodeType = 3; n.data = t; return n; },
    dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null, contains: () => false, activeElement: null,
  };
  g.window = { addEventListener() {}, removeEventListener() {}, innerHeight: 800, innerWidth: 1200, matchMedia: () => ({ matches: false }) };
  g.CSSStyleSheet = class { replaceSync() {} };
  g.getComputedStyle = () => ({ getPropertyValue: () => "0px" });
  g.requestAnimationFrame = () => 0;
  return () => { for (const key of keys) g[key] = previous[key]; };
}
export const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
};
