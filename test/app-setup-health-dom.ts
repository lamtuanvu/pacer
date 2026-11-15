import { render as preactRender } from "preact";
import { act } from "preact/test-utils";

/**
 * Minimal DOM for preact DOM-render + click tests (mirrors the selElement fake
 * used by app-dispatcher-model-choice.test.tsx). This preact build binds each
 * event directly to the element (element.addEventListener('click', wrapper))
 * and keeps the real handler in element.l[eventName]; our click()/submit()
 * invoke that registered wrapper so the component's prop handlers run.
 */

interface SelEvent {
  type: string;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  target: SelNode;
  currentTarget: SelNode;
  preventDefault(): void;
  stopPropagation(): void;
}

type Listener = (event: SelEvent) => void;

interface SelNode {
  nodeType: number;
  tagName: string;
  localName: string;
  ownerDocument: SelDocument;
  parentNode: SelNode | null;
  childNodes: SelNode[];
  data?: string;
  attrs: Record<string, string>;
  _listeners: Record<string, Listener>;
  l?: Record<string, Listener>;
  style: Record<string, unknown> & { setProperty: (key: string, value: unknown) => void };
  className: string;
  innerHTML: string;
  attributes: { name: string; value: string }[];
  textContent: string;
  onclick: null;
  oninput: null;
  onchange: null;
  onfocus: null;
  onblur: null;
  onkeydown: null;
  onsubmit: null;
  addEventListener: (type: string, fn: Listener, capture?: unknown) => void;
  removeEventListener: (type: string, fn?: unknown, capture?: unknown) => void;
  setAttribute: (name: string, value: unknown) => void;
  getAttribute: (name: string) => string | null;
  removeAttribute: (name: string) => void;
  appendChild: (child: SelNode) => SelNode;
  insertBefore: (child: SelNode, before: SelNode | null) => SelNode;
  removeChild: (child: SelNode) => SelNode;
  remove: () => void;
  focus: (opts?: { preventScroll?: boolean }) => void;
  showModal: () => void;
  close: () => void;
  matches: () => boolean;
  closest: () => null;
  getClientRects: () => [];
  querySelector: () => null;
  querySelectorAll: () => [];
  click: (type?: string) => void;
  submit: () => void;
  dispatchEvent: (event: SelEvent) => void;
  get firstChild(): SelNode | null;
  get nextSibling(): SelNode | null;
  get isConnected(): boolean;
}

interface SelDocument {
  nodeType: number;
  nodeName: string;
  activeElement: SelNode | null;
  documentElement: SelNode;
  adoptedStyleSheets: unknown[];
  createElement: (tag: string) => SelNode;
  createElementNS: (namespace: string, tag: string) => SelNode;
  createTextNode: (text: string) => SelNode;
  createComment: (text: string) => SelNode;
  addEventListener: (type: string, fn: Listener, capture?: unknown) => void;
  removeEventListener: (type: string, fn?: unknown, capture?: unknown) => void;
  dispatchEvent: (event: SelEvent) => void;
  getElementById: () => null;
  querySelector: () => null;
  querySelectorAll: () => [];
  contains: () => false;
}

function makeEvent(type: string, target: SelNode): SelEvent {
  const event: SelEvent = {
    type,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    target,
    currentTarget: target,
    preventDefault() { event.defaultPrevented = true; },
    stopPropagation() {},
  };
  return event;
}

function insertChild(parent: SelNode, child: SelNode, before: SelNode | null): void {
  if (child.parentNode) {
    child.parentNode.childNodes = child.parentNode.childNodes.filter(c => c !== child);
  }
  const at = before ? parent.childNodes.indexOf(before) : -1;
  if (at < 0) parent.childNodes.push(child);
  else parent.childNodes.splice(at, 0, child);
  child.parentNode = parent;
}

export function createElementNode(tag: string, doc: SelDocument): SelNode {
  const node = {
    nodeType: 1,
    tagName: tag,
    localName: tag,
    ownerDocument: doc,
    parentNode: null,
    childNodes: [],
    attrs: {},
    _listeners: {},
    style: { setProperty() {} },
    className: "",
    innerHTML: "",
    attributes: [],
    textContent: "",
    onclick: null,
    oninput: null,
    onchange: null,
    onfocus: null,
    onblur: null,
    onkeydown: null,
    onsubmit: null,
    addEventListener(type: string, fn: Listener) { node._listeners[type] = fn; },
    removeEventListener(type: string, fn?: unknown, capture?: unknown) { delete node._listeners[type]; },
    setAttribute(name: string, value: unknown) { node.attrs[name] = String(value); },
    getAttribute(name: string) { return name in node.attrs ? node.attrs[name] : null; },
    removeAttribute(name: string) { delete node.attrs[name]; },
    appendChild(child: SelNode) { insertChild(node, child, null); return child; },
    insertBefore(child: SelNode, before: SelNode | null) { insertChild(node, child, before); return child; },
    removeChild(child: SelNode) { node.childNodes = node.childNodes.filter(c => c !== child); child.parentNode = null; return child; },
    remove() { node.parentNode?.removeChild(node); },
    focus(_opts?: { preventScroll?: boolean }) { doc.activeElement = node; },
    showModal() {},
    close() {},
    matches() { return false; },
    closest() { return null; },
    getClientRects() { return []; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    click(type = "click") { node._listeners[type]?.call(node, makeEvent(type, node)); },
    submit() { node._listeners["submit"]?.call(node, makeEvent("submit", node)); },
    dispatchEvent(event: SelEvent) { node._listeners[event.type]?.call(node, event); },
    get firstChild() { return node.childNodes[0] ?? null; },
    get nextSibling() {
      const parent = node.parentNode;
      if (!parent) return null;
      const index = parent.childNodes.indexOf(node);
      return index < 0 ? null : parent.childNodes[index + 1] ?? null;
    },
    get isConnected() { return node.parentNode !== null; },
  } as unknown as SelNode;
  return node;
}

export function createTextNode(text: string, doc: SelDocument): SelNode {
  const node = createElementNode("#text", doc);
  node.nodeType = 3;
  node.tagName = "";
  node.localName = "";
  node.data = text;
  return node;
}

export function createCommentNode(text: string, doc: SelDocument): SelNode {
  const node = createElementNode("#comment", doc);
  node.nodeType = 8;
  node.tagName = "";
  node.localName = "";
  node.data = text;
  return node;
}

export interface TestDom {
  doc: SelDocument;
  container: SelNode;
  restore(): void;
}

export function installDom(): TestDom {
  const previous: Record<string, unknown> = {
    document: (globalThis as Record<string, unknown>).document,
    window: (globalThis as Record<string, unknown>).window,
    location: (globalThis as Record<string, unknown>).location,
    navigator: (globalThis as Record<string, unknown>).navigator,
    CSSStyleSheet: (globalThis as Record<string, unknown>).CSSStyleSheet,
    getComputedStyle: (globalThis as Record<string, unknown>).getComputedStyle,
    requestAnimationFrame: (globalThis as Record<string, unknown>).requestAnimationFrame,
  };

  const doc = {
    nodeType: 9,
    nodeName: "#document",
    activeElement: null,
    documentElement: null as unknown as SelNode,
    adoptedStyleSheets: [],
    createElement: (tag: string) => createElementNode(tag, doc),
    createElementNS: (_namespace: string, tag: string) => createElementNode(tag, doc),
    createTextNode: (text: string) => createTextNode(text, doc),
    createComment: (text: string) => createCommentNode(text, doc),
    addEventListener(_type: string, _fn: Listener, _capture?: unknown) {},
    removeEventListener(_type: string, _fn?: unknown, _capture?: unknown) {},
    dispatchEvent() {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
  } as unknown as SelDocument;

  const root = createElementNode("html", doc);
  doc.documentElement = root;

  const container = createElementNode("div", doc);
  container.setAttribute("id", "test-root");

  const win = {
    innerHeight: 800,
    innerWidth: 1200,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: number) => clearInterval(id),
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0),
  };

  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).location = { hash: "#/", toString: () => "" };
  (globalThis as Record<string, unknown>).navigator = { platform: "", userAgent: "", language: "en" };
  (globalThis as Record<string, unknown>).CSSStyleSheet = class { replaceSync() {} };
  (globalThis as Record<string, unknown>).getComputedStyle = () => ({ getPropertyValue: () => "" });
  (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0);

  return {
    doc,
    container,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
        else (globalThis as Record<string, unknown>)[key] = value;
      }
    },
  };
}

/** Render a vnode into the fake-DOM container inside an act() so effects settle. */
export async function mount<V>(dom: TestDom, vnode: V): Promise<void> {
  await act(async () => { preactRender(vnode as never, dom.container as never); });
}

/** Unmount the current tree inside an act(). */
export async function unmount(dom: TestDom): Promise<void> {
  await act(async () => { preactRender(null as never, dom.container as never); });
}

/** Every element node under `root`, depth-first. */
function allNodes(root: SelNode): SelNode[] {
  const out: SelNode[] = [];
  const walk = (node: SelNode) => {
    if (node.nodeType === 1) out.push(node);
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return out;
}

/** Rendered text of a node (including descendants). */
export function nodeText(node: SelNode): string {
  if (node.nodeType === 3) return node.data ?? "";
  if (node.nodeType === 8) return "";
  return node.childNodes.map(nodeText).join("");
}

/** The subtree's whole text, for "does the stage show X" style assertions. */
export function domText(node: SelNode): string {
  return nodeText(node);
}

/** First element (preferably a button) whose trimmed text equals `text`. */
export function findByText(root: SelNode, text: string): SelNode | null {
  const buttons = allNodes(root).filter(n => n.tagName === "button");
  return buttons.find(n => nodeText(n).trim() === text) ?? null;
}

/** Click an element whose trimmed text equals `text`; fails loudly if absent. */
export function clickText(root: SelNode, text: string): void {
  const node = findByText(root, text);
  if (!node) throw new Error(`clickText: no button with text "${text}"`);
  node.click();
}

/** Submit the first <form> in the tree (used to accept the gate's confirm dialog). */
export function submitForm(root: SelNode): void {
  const form = allNodes(root).find(n => n.tagName === "form");
  if (!form) throw new Error("submitForm: no form found");
  form.submit();
}

/** Number of times a <form> (confirm dialog) is visible in the current tree. */
export function countForms(root: SelNode): number {
  return allNodes(root).filter(n => n.tagName === "form").length;
}

/** Wait (polling) until `predicate` is true or `ms` elapses; throws on timeout. */
export async function until(predicate: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("until: condition not reached in time");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Wait a small amount so async set-state / effects flush. */
export async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 10));
}

/** Whether the button whose trimmed text equals `text` is disabled. */
export function isDisabled(root: SelNode, text: string): boolean {
  const node = findByText(root, text);
  return node != null && node.getAttribute("disabled") != null;
}