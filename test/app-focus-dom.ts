/**
 * Focus support for the fake DOM in app-setup-health-dom: the queries Dialog and cycleDialogFocus use
 * (FOCUSABLE, [data-autofocus]), radio properties and document order. Install before mounting.
 */
import type { TestDom } from "./app-setup-health-dom";

type Node = any;

const TAB_TAGS = new Set(["a", "button", "input", "select", "textarea", "summary"]);

function descendants(node: Node): Node[] {
  return node.childNodes.filter((child: Node) => child.nodeType === 1).flatMap((child: Node) => [child, ...descendants(child)]);
}

const tabbable = (node: Node) => {
  const index = node.attrs.tabIndex ?? node.attrs.tabindex;
  if (index === "-1") return false;
  return index !== undefined || (TAB_TAGS.has(node.localName) && (node.localName !== "a" || "href" in node.attrs));
};

function select(root: Node, selector: string): Node[] {
  if (selector === "[data-autofocus]") return descendants(root).filter(n => "data-autofocus" in n.attrs);
  // FOCUSABLE: native controls (even tabindex -1, which callers filter out) and explicit tab stops.
  return descendants(root).filter(n => TAB_TAGS.has(n.localName) || tabbable(n));
}

function enhance(node: Node): Node {
  const rootOf = (n: Node): Node => n.parentNode ? rootOf(n.parentNode) : n;
  Object.defineProperties(node, {
    type: { configurable: true, get: () => node.attrs.type ?? "", set: value => { node.attrs.type = String(value); } },
    name: { configurable: true, get: () => node.attrs.name ?? "", set: value => { node.attrs.name = String(value); } },
    checked: {
      configurable: true,
      get: () => "checked" in node.attrs && node.attrs.checked !== "false",
      set: value => { if (value) node.attrs.checked = "true"; else delete node.attrs.checked; },
    },
    form: {
      configurable: true,
      get: () => { let n = node.parentNode; while (n && n.localName !== "form") n = n.parentNode; return n; },
    },
  });
  node.querySelectorAll = (selector: string) => select(node, selector);
  node.querySelector = (selector: string) => select(node, selector)[0] ?? null;
  node.contains = (other: Node) => other === node || descendants(node).includes(other);
  node.compareDocumentPosition = (other: Node) => {
    const order = [rootOf(node), ...descendants(rootOf(node))];
    if (node.contains(other)) return 16 | 4;
    return order.indexOf(other) < order.indexOf(node) ? 2 : 4;
  };
  node.matches = () => "disabled" in node.attrs || (node.attrs.tabIndex ?? node.attrs.tabindex) === "-1";
  node.getClientRects = () => [1];
  return node;
}

export function enableFocusQueries(dom: TestDom): void {
  const create = dom.doc.createElement.bind(dom.doc);
  dom.doc.createElement = (tag: string) => enhance(create(tag));
  dom.doc.createElementNS = (_namespace: string, tag: string) => enhance(create(tag));
}

export function findAll(root: unknown, predicate: (node: Node) => boolean): Node[] {
  return descendants(root).filter(predicate);
}

/** A readable name for the focused element, for Tab-order assertions. */
export function focusName(node: Node): string {
  if (!node) return "none";
  const text = (n: Node): string => n.nodeType === 3 ? String(n.data ?? "") : n.nodeType === 8 ? "" : n.childNodes.map(text).join("");
  if (node.localName === "input") {
    const type = node.attrs.type ?? "text";
    return type === "radio" || type === "checkbox" ? `${type}:${node.value ?? node.attrs.value}` : "input";
  }
  return `${node.localName}:${text(node).trim()}`;
}

/** Press Tab on the dialog the way the browser delivers it, and return where focus went. */
export function pressTab(dom: TestDom, shiftKey = false): string {
  const dialog: Node = findAll(dom.container, n => n.localName === "dialog")[0];
  const event: any = {
    type: "keydown", key: "Tab", shiftKey, bubbles: true, cancelable: true, defaultPrevented: false,
    target: dom.doc.activeElement, currentTarget: dialog,
    preventDefault() { event.defaultPrevented = true; }, stopPropagation() {},
  };
  dialog.dispatchEvent(event);
  return focusName(dom.doc.activeElement);
}
