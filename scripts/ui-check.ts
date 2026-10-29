import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { parse } from "@babel/parser";
import type * as t from "@babel/types";
import { checkUiPullRequest } from "./ui-check-evidence";

export interface UiViolation { path: string; line: number; rule: string; message: string }

const generated = new Set(["app/src/ds/tokens.css", "app/src/ds/tokens.ts"]);
const rawControls = new Set(["button", "input", "select", "textarea", "details"]);
const linkClasses = new Set(["pc-inline-link", "pc-text-action", "pc-btn"]);
const inherited = /^(?:inherit|initial|unset|revert|revert-layer)$/i;
const typeProperty = /^(?:font|font-size|font-family|font-weight|font-stretch|line-height|letter-spacing|text-underline-offset)$/;
const visualProperty = /^(?:color|text-fill-color|text-stroke(?:-.+)?|background(?:-.+)?|accent-color|fill|stroke(?:-.+)?|border(?:-.+)?|outline(?:-.+)?|box-shadow|text-shadow|padding(?:-.+)?|margin(?:-.+)?|(?:row-|column-)?gap|inset(?:-.+)?|top|right|bottom|left|(?:min-|max-)?(?:width|height|inline-size|block-size)|flex-basis|grid-template-.+|z-index|animation(?:-.+)?|transition(?:-.+)?|scroll-margin(?:-.+)?|scroll-padding(?:-.+)?|list-style(?:-.+)?)$/;
const colorProperty = /(?:color|background|fill|stroke|border|outline|shadow)/;
const safeWords = new Set("auto none normal transparent currentcolor solid dashed dotted double hidden inset outset groove ridge thin medium thick round square butt miter bevel collapse separate content-box border-box cover contain center left right top bottom repeat no-repeat repeat-x repeat-y space round local fixed scroll padding-box border-box text closest-side farthest-side circle ellipse at in srgb oklab oklch hsl hue longer shorter increasing decreasing linear ease ease-in ease-out ease-in-out step-start step-end infinite alternate alternate-reverse reverse forwards backwards both running paused all color opacity transform visibility background-color border-color pointer-events normal bold".split(" "));

function normalize(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\//, ""); }
function cssProperty(name: string): string {
  return name.startsWith("--") ? name : name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
}

// Keep fallbacks visible: var(--space, 9px) is still a literal bypass.
function withoutTokenReferences(value: string): string {
  let result = "";
  for (let i = 0; i < value.length;) {
    if (value.slice(i, i + 4).toLowerCase() !== "var(") { result += value[i++]; continue; }
    let depth = 1, cursor = i + 4, comma = -1;
    for (; cursor < value.length && depth; cursor++) {
      if (value[cursor] === "(") depth++;
      if (value[cursor] === ")") depth--;
      if (value[cursor] === "," && depth === 1 && comma < 0) comma = cursor;
    }
    const args = value.slice(i + 4, depth ? value.length : cursor - 1);
    if (!/^--[\w.\\-]+(?:\s*,[\s\S]*)?$/.test(args.trim())) result += " INVALID_TOKEN ";
    else result += comma < 0 ? " TOKEN " : ` TOKEN ${withoutTokenReferences(value.slice(comma + 1, cursor - 1))} `;
    i = cursor;
  }
  return result;
}

function decodeCssIdentifier(value: string): string {
  return value.replace(/\\([a-f0-9]{1,6})(?:\r\n|[ \t\r\n\f])?|\\([^\r\n\f])/gi, (_match, hex: string | undefined, char: string | undefined) => {
    if (!hex) return char ?? "";
    const point = parseInt(hex, 16);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "\uFFFD";
  });
}

function invalidCssValue(property: string, original: string): boolean {
  property = property.replace(/^-(?:webkit|moz|ms|o)-/, "");
  if (!typeProperty.test(property) && !visualProperty.test(property) && !property.startsWith("--")) return false;
  const value = original.trim().replace(/\s*!important\s*$/i, "");
  if (inherited.test(value)) return false;
  const remainder = withoutTokenReferences(value).replace(/TOKEN/g, " ").trim();
  if (!remainder) return false;
  if (/^(?:border(?:-.+)?|outline(?:-.+)?|(?:text-)?stroke(?:-width)?)$/.test(property) && /\b(?:thin|medium|thick)\b/i.test(remainder)) return true;
  if (property.startsWith("--")) {
    // Custom properties cannot turn literal weight/size/color keywords into tokens.
    const words = remainder.replace(/-?\d*\.?\d+(?:%|[a-z]+)?/gi, " ").match(/[a-z][\w-]*/gi) ?? [];
    if (words.some(word => !["transparent", "currentcolor", "calc", "min", "max", "clamp"].includes(word.toLowerCase()))) return true;
  }
  if (typeProperty.test(property)) {
    if (/^(?:normal|0)$/.test(remainder) && property !== "font-weight") return false;
    return true;
  }
  // CSS colors are accepted only via tokens, transparent, currentColor or inheritance.
  if (/#(?:[\da-f]{3,8})\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\s*\(/i.test(remainder)) return true;
  if ((colorProperty.test(property) || property.startsWith("--"))) {
    const words = remainder.replace(/-?\d*\.?\d+(?:%|[a-z]+)?/gi, " ").match(/[a-z][\w-]*/gi) ?? [];
    if (words.some(word => !safeWords.has(word.toLowerCase()) && !["calc", "min", "max", "clamp", "color-mix", "linear-gradient", "radial-gradient", "repeating-linear-gradient"].includes(word.toLowerCase()))) return true;
  }
  const numbers = remainder.matchAll(/(-?(?:\d*\.)?\d+)([a-z%]*)/gi);
  for (const match of numbers) {
    const number = Number(match[1]), unit = match[2]!.toLowerCase();
    if (number === 0 || unit === "%" || unit === "fr") continue;
    if (["width", "height"].includes(property) && number === 1 && unit === "em") continue;
    // Multiplication/division of a token preserves the canonical measurement.
    if (!unit && value.includes("var(") && /(?:[*/]\s*|\d\s*[*/])/.test(remainder) && /calc\(/.test(value)) continue;
    if (/^(?:min-|max-)?(?:width|height|inline-size|block-size)$/.test(property) && /^(?:vh|vw|dvh|dvw|svh|svw|lvh|lvw)$/.test(unit)) continue;
    if (/^(?:border(?:-.+)?|outline(?:-.+)?)$/.test(property) && !property.includes("radius") && Math.abs(number) === 1 && unit === "px") continue;
    // Layout proportions and motion geometry are not token measurements.
    if (/^(?:flex(?:-.+)?|grid-template-.+)$/.test(property) && !unit) continue;
    if (unit === "deg" || unit === "turn") continue;
    return true;
  }
  return false;
}

interface Declaration { property: string; value: string; position: number }
function cssDeclarations(source: string): Declaration[] {
  // Blank comments without moving offsets, so diagnostics preserve original lines.
  const text = source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, " "));
  const declarations: Declaration[] = [];
  let start = 0, colon = -1, parentheses = 0, quote = "";
  const flush = (end: number) => {
    if (colon < 0) return;
    const property = decodeCssIdentifier(text.slice(start, colon).trim());
    if (/^(?:--[\w-]+|[a-zA-Z-]+)$/.test(property)) declarations.push({ property: property.toLowerCase(), value: text.slice(colon + 1, end), position: start + text.slice(start, colon).search(/\S/) });
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote) { if (char === quote && text[i - 1] !== "\\") quote = ""; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "(") parentheses++;
    if (char === ")") parentheses--;
    if (parentheses) continue;
    if (char === ":" && colon < 0) colon = i;
    if (char === "{") { start = i + 1; colon = -1; }
    if (char === ";" || char === "}") { flush(i); start = i + 1; colon = -1; }
  }
  flush(text.length);
  return declarations;
}

/** Retain selector ancestry through native CSS nesting and conditional blocks. */
function sharedSpacingOverrides(source: string): number[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, " "));
  const owned = /\.pc-(?:stack(?:--[\w-]+)?|detail-navigation|page-body|page-header(?:__[\w-]+)?|section|composed-section(?:__[\w-]+)?|disclosure-panel(?:__[\w-]+)?|action-panel)(?![\w-])/;
  const stack: { start: number; owned: boolean }[] = [];
  const ranges: { start: number; end: number }[] = [];
  let boundary = 0, quote = "", parentheses = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (quote) { if (char === quote && text[at - 1] !== "\\") quote = ""; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "(") parentheses++;
    if (char === ")") parentheses--;
    if (parentheses) continue;
    if (char === "{") {
      stack.push({ start: at + 1, owned: !!stack.at(-1)?.owned || owned.test(decodeCssIdentifier(text.slice(boundary, at))) });
      boundary = at + 1;
    } else if (char === "}") {
      const frame = stack.pop();
      if (frame?.owned) ranges.push({ start: frame.start, end: at });
      boundary = at + 1;
    } else if (char === ";") boundary = at + 1;
  }
  return cssDeclarations(text).filter(declaration =>
    /^(?:margin|padding|(?:grid-)?(?:row-|column-)?gap)(?:-|$)/.test(declaration.property) &&
    ranges.some(range => declaration.position >= range.start && declaration.position < range.end)
  ).map(declaration => declaration.position);
}

interface CssImport { specifier?: string; position: number }
function cssImports(source: string): CssImport[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, " "));
  const imports: CssImport[] = [];
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    if (quote) { if (text[i] === quote && text[i - 1] !== "\\") quote = ""; continue; }
    if (text[i] === '"' || text[i] === "'") { quote = text[i]!; continue; }
    if (!/^@import\b/i.test(text.slice(i))) continue;
    const afterKeyword = text.slice(i + 7);
    const value = afterKeyword.trimStart();
    const valueStart = i + 7 + afterKeyword.length - value.length;
    const match = /^(?:(["'])(.*?)\1|url\(\s*(?:(["'])(.*?)\3|([^\s"'()]+))\s*\))/i.exec(value);
    imports.push({ position: i, specifier: match ? decodeCssIdentifier(match[2] ?? match[4] ?? match[5] ?? "") : undefined });
    i = match ? valueStart + match[0].length - 1 : i + 6;
  }
  return imports;
}

function walk(node: t.Node, visitor: (node: t.Node, ancestors: t.Node[]) => void, ancestors: t.Node[] = []): void {
  visitor(node, ancestors);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child === "object" && typeof child.type === "string") walk(child, visitor, [...ancestors, node]);
    } else if (value && typeof value === "object" && "type" in value && typeof value.type === "string") walk(value as t.Node, visitor, [...ancestors, node]);
  }
}
function propertyName(node: t.Node): string | undefined {
  if (node.type === "Identifier" || node.type === "JSXIdentifier") return node.name;
  if (node.type === "StringLiteral") return node.value;
  return undefined;
}

/** Inspect one authored app source. This checker never rewrites or suppresses findings. */
export function checkUiSource(inputPath: string, source: string): UiViolation[] {
  const path = normalize(inputPath), violations: UiViolation[] = [];
  if (generated.has(path)) return violations;
  const add = (position: number, rule: string, message: string) => {
    violations.push({ path, line: source.slice(0, position).split("\n").length, rule, message });
  };
  const checkCss = (text: string, offset = 0) => {
    for (const declaration of cssDeclarations(text)) {
      const assistantMark = path === "app/src/ds/components.css"
        && /(?:^|})\s*\.pc-aurora-avatar\{[^{}]*$/.test(text.slice(0, declaration.position))
        && declaration.property === "background"
        && declaration.value.trim() === "conic-gradient(from 200deg,var(--aurora-1),var(--aurora-3),var(--aurora-2),var(--aurora-1))";
      if (!assistantMark && invalidCssValue(declaration.property, declaration.value)) add(offset + declaration.position, "UI-21", `Use a design token for ${declaration.property}: ${declaration.value.trim()}.`);
    }
  };
  if (path.endsWith(".css")) {
    checkCss(source);
    if (!path.startsWith("app/src/ds/")) {
      for (const position of sharedSpacingOverrides(source)) {
        add(position, "UI-27", "Shared layout spacing belongs to DS; compose Stack/Section/DisclosurePanel instead of overriding their margins, padding or gaps.");
      }
    }
    if (path.startsWith("app/src/screens/")) {
      const pageRoot = /\.(?:pc-overview|pc-session|pc-sessions-list|u3-settings|pc-setup)\s*\{[^}]*\b(?:max-width|margin(?:-inline)?|padding)\s*:/g;
      for (const match of source.matchAll(pageRoot)) add(match.index ?? 0, "UI-25", "Routed screen roots cannot own maximum width, centering, or outer gutters; use the shared Page contract.");
    }
    if (path.startsWith("app/src/ds/")) {
      for (const imported of cssImports(source)) {
        const specifier = imported.specifier;
        const target = specifier ? posix.normalize(posix.join(posix.dirname(path), specifier)) : "";
        if (!specifier || /^(?:[a-z][\w+.-]*:|\/)|[()]/i.test(specifier) || !target.startsWith("app/src/ds/")) add(imported.position, "UI-20", `Design-system CSS can import only inspectable DS-owned stylesheets: '${specifier ?? "unsupported import"}'.`);
      }
    }
    return violations;
  }
  if (!/\.[cm]?[jt]sx?$/.test(path)) return [];
  const inDs = path.startsWith("app/src/ds/");
  let file: t.File;
  try { file = parse(source, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] }); }
  catch (error) {
    add(0, "UI-25", `Cannot inspect UI source: ${error instanceof Error ? error.message : String(error)}`);
    return violations;
  }
  const bindings = new Map<string, t.Expression | null>();
  walk(file, node => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init && node.init.type !== "AwaitExpression") {
      bindings.set(node.id.name, bindings.has(node.id.name) ? null : node.init as t.Expression);
    }
  });
  const resolveExpression = (node: t.Node, seen = new Set<string>()): t.Node => {
    if (["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(node.type)) return resolveExpression((node as t.TSAsExpression).expression, seen);
    if (node.type === "Identifier" && bindings.get(node.name) && !seen.has(node.name)) {
      seen.add(node.name); return resolveExpression(bindings.get(node.name)!, seen);
    }
    return node;
  };
  const memberName = (node: t.MemberExpression): string | undefined => {
    if (!node.computed) return propertyName(node.property);
    const property = resolveExpression(node.property);
    return property.type === "StringLiteral" ? property.value : undefined;
  };
  const checkImport = (node: t.Node, specifier: string) => {
    const target = specifier.startsWith(".") ? posix.normalize(posix.join(posix.dirname(path), specifier)) : specifier;
    if (target.startsWith("app/src/ds/") || target.startsWith("src/view-model/") || target === "preact" || target.startsWith("preact/")) return;
    add(node.start ?? 0, "UI-20", `Design-system components cannot import consumer or service module '${specifier}'; pass presentation props instead.`);
  };
  const checkProperty = (node: t.Node, name: string, value: t.Node, ancestors: t.Node[] = []) => {
    name = cssProperty(name);
    // The assistant offsets consume only measured dock/session-header geometry on the frame.
    if (path === "app/src/shell/AppFrame.tsx" && ["--pc-dock-height", "--pc-assistant-header-height"].includes(name)
      && node.type === "CallExpression" && node.callee.type === "MemberExpression"
      && source.slice(node.callee.start ?? 0, node.callee.end ?? 0) === "root.style.setProperty"
      && value.type === "TemplateLiteral" && value.expressions.length === 1
      && value.quasis[0]?.value.cooked === "" && value.quasis[1]?.value.cooked === "px"
      && source.slice(value.expressions[0]!.start ?? 0, value.expressions[0]!.end ?? 0) === (name === "--pc-dock-height" ? "dock?.getBoundingClientRect().height ?? 0" : "sessionHeader && body ? Math.max(0, sessionHeader.getBoundingClientRect().bottom - body.getBoundingClientRect().top) : 0")) return;
    // These exact data channels are owned by the meter and are unitless clamped values.
    if (path === "app/src/ds/UsageMeter.tsx" && ["--used", "--pace"].includes(name)
      && value.type === "CallExpression" && value.callee.type === "Identifier" && value.callee.name === "clamp" && value.arguments.length === 1
      && value.arguments[0]?.type === "Identifier" && value.arguments[0].name === name.slice(2)) return;
    // Brand mark size is a geometric adapter, scoped to a single parameter/property.
    const brandMetric = (path === "app/src/ds/AgentMark.tsx" && name === "--agent-size") || (path === "app/src/ds/Mark.tsx" && name === "--mark-size");
    if (brandMetric && value.type === "TemplateLiteral" && value.expressions.length === 1
      && value.expressions[0]?.type === "Identifier" && value.expressions[0].name === "size"
      && value.quasis[0]?.value.cooked === "" && value.quasis[1]?.value.cooked === "px") return;
    // Restoring a pre-swap measurement introduces no authored design dimension.
    if (path === "app/src/ds/SelectionStrip.tsx" && name === "min-height"
      && node.type === "AssignmentExpression" && source.slice(node.left.start ?? 0, node.left.end ?? 0) === "parent.style.minHeight"
      && value.type === "Identifier" && value.name === "minimum"
      && source.slice(resolveExpression(value).start ?? 0, resolveExpression(value).end ?? 0) === "parent.style.minHeight") return;
    // SelectionStrip adapts measured item/panel rectangles; no authored visual lengths.
    if (path === "app/src/ds/SelectionStrip.tsx" && node.type === "AssignmentExpression" && node.left.type === "MemberExpression"
      && value.type === "TemplateLiteral" && value.expressions.length === 1
      && value.quasis[0]?.value.cooked === "" && value.quasis[1]?.value.cooked === "px") {
      const target = source.slice(node.left.start ?? 0, node.left.end ?? 0);
      const metric = source.slice(value.expressions[0]!.start ?? 0, value.expressions[0]!.end ?? 0);
      if ((name === "width" && target === "marker.style.width" && metric === "selected.getBoundingClientRect().width")
        || (name === "height" && target === "marker.style.height" && metric === "selected.getBoundingClientRect().height")
        || (name === "min-height" && target === "parent.style.minHeight" && ["Math.max(parent.offsetHeight, panel.offsetHeight, Number(old.dataset.containerHeight))", "parent.offsetHeight"].includes(metric))) return;
    }
    // Viewer sizing is authoritative PTY/measured geometry, scoped to scale() assignments.
    const terminalScale = path === "app/src/term/term.tsx" && ["width", "height"].includes(name)
      && ancestors.some(parent => parent.type === "VariableDeclarator" && parent.id.type === "Identifier" && parent.id.name === "scale")
      && node.type === "AssignmentExpression" && node.left.type === "MemberExpression"
      && source.slice(node.left.object.start ?? 0, node.left.object.end ?? 0).replace(/\s/g, "") === "mount.current.style";
    if (terminalScale && value.type === "TemplateLiteral" && value.expressions.length === 1
      && value.quasis[0]?.value.cooked === "" && value.quasis[1]?.value.cooked === "px") {
      const expression = value.expressions[0]!;
      const code = source.slice(expression.start ?? 0, expression.end ?? 0).replace(/\s/g, "");
      const allowed = name === "width" ? ["screen.offsetWidth", "term.cols*term.options.fontSize!*0.61"] : ["screen.offsetHeight", "term.rows*term.options.fontSize!*1.2"];
      if (allowed.includes(code)) return;
    }
    let literal: string | undefined;
    if (value.type === "StringLiteral" || value.type === "NumericLiteral") literal = String(value.value);
    if (value.type === "TemplateLiteral" && !value.expressions.length) literal = value.quasis[0]?.value.cooked ?? undefined;
    if (literal !== undefined) {
      if (invalidCssValue(name, literal)) add(node.start ?? 0, "UI-21", `Use a design token for inline ${name}: ${literal}.`);
    } else if (typeProperty.test(name) || visualProperty.test(name) || name.startsWith("--")) {
      add(node.start ?? 0, "UI-21", `Dynamic inline ${name} cannot be checked; use a DS variant or a documented data-geometry adapter.`);
    }
  };
  const checkStyle = (node: t.Node, seen = new Set<string>()) => {
    if (["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(node.type)) {
      checkStyle((node as t.TSAsExpression).expression, seen); return;
    }
    if (node.type === "Identifier" && bindings.get(node.name) && !seen.has(node.name)) {
      seen.add(node.name); checkStyle(bindings.get(node.name)!, seen); return;
    }
    if (node.type === "StringLiteral") { checkCss(node.value, (node.start ?? 0) + 1); return; }
    if (node.type !== "ObjectExpression") {
      add(node.start ?? 0, "UI-21", "Inline style must be a statically inspectable token object; use a DS variant for dynamic visual styles."); return;
    }
    for (const property of node.properties) {
      if (property.type !== "ObjectProperty" || property.computed || property.shorthand || !propertyName(property.key)) {
        add(property.start ?? 0, "UI-21", "Style spreads, shorthand and computed properties evade token checks; use explicit token properties."); continue;
      }
      checkProperty(property, propertyName(property.key)!, property.value);
    }
  };
  const checkProps = (node: t.Node, seen = new Set<t.Node>()) => {
    node = resolveExpression(node);
    if (seen.has(node)) return;
    seen.add(node);
    // Unresolved native-attribute forwarding is not itself an authored style.
    // Known local objects are inspected recursively; explicit style values fail closed.
    if (node.type !== "ObjectExpression") return;
    for (const property of node.properties) {
      if (property.type === "SpreadElement") { checkProps(property.argument, seen); continue; }
      const key = property.computed ? resolveExpression(property.key) : property.key;
      const name = property.computed && key.type !== "StringLiteral" ? undefined : propertyName(key);
      if (name !== "style") continue;
      if (property.type !== "ObjectProperty") add(property.start ?? 0, "UI-21", "Style-bearing props must expose a statically inspectable token style object.");
      else checkStyle(property.value);
    }
  };
  const elementFactories = new Set(["h", "createElement"]);
  walk(file, node => {
    if (node.type === "ImportDeclaration" && node.source.value === "preact") {
      for (const specifier of node.specifiers) if (specifier.type === "ImportSpecifier" && ["h", "createElement"].includes(propertyName(specifier.imported) ?? "")) elementFactories.add(specifier.local.name);
    }
  });
  walk(file, (node, ancestors) => {
    if (node.type === "CallExpression") {
      const factory = node.callee.type === "Identifier" ? node.callee.name : node.callee.type === "MemberExpression" ? propertyName(node.callee.property) : undefined;
      const tag = node.arguments[0];
      if (factory && elementFactories.has(factory) && node.arguments[1]) checkProps(node.arguments[1]);
      if (!inDs && factory && elementFactories.has(factory) && tag?.type === "StringLiteral" && (rawControls.has(tag.value) || tag.value === "a")) add(node.start ?? 0, "UI-19", `Use a canonical DS component instead of constructing raw <${tag.value}>.`);
    }
    if (inDs) {
      if ((node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source) checkImport(node, node.source.value);
      if (node.type === "TSImportType" && node.source.type === "StringLiteral") checkImport(node, node.source.value);
      if (node.type === "TSExternalModuleReference" && node.expression.type === "StringLiteral") checkImport(node, node.expression.value);
      if (node.type === "ImportExpression") {
        if (node.source.type === "StringLiteral") checkImport(node, node.source.value);
        else add(node.start ?? 0, "UI-20", "Dynamic module specifiers cannot prove the design-system import boundary.");
      }
      if (node.type === "CallExpression" && (node.callee.type === "Import" || (node.callee.type === "Identifier" && node.callee.name === "require"))) {
        const specifier = node.arguments[0];
        if (specifier?.type === "StringLiteral") checkImport(node, specifier.value);
        else add(node.start ?? 0, "UI-20", "Dynamic module specifiers cannot prove the design-system import boundary.");
      }
    }
    if (node.type === "JSXOpeningElement") {
      const tag = propertyName(node.name);
      if (tag === "style") add(node.start ?? 0, "UI-21", "Keep authored styles in checked CSS files; injected style elements evade declaration ownership.");
      if (!inDs && tag && rawControls.has(tag)) add(node.start ?? 0, "UI-19", `Use the canonical DS ${tag} component instead of raw <${tag}>.`);
      if (!inDs && tag === "a") {
        let canonical = false;
        for (const attr of node.attributes) {
          if (attr.type === "JSXSpreadAttribute") { canonical = false; continue; }
          if (attr.type !== "JSXAttribute" || !["class", "className"].includes(propertyName(attr.name) ?? "")) continue;
          const value = attr.value?.type === "JSXExpressionContainer" ? attr.value.expression : attr.value;
          if (value?.type === "StringLiteral" && value.value.split(/\s+/).some(name => linkClasses.has(name))) canonical = true;
        }
        if (!canonical) add(node.start ?? 0, "UI-19", "Use LinkButton/TextLink or a canonical pc-inline-link, pc-text-action or pc-btn anchor class.");
      }
      for (const attr of node.attributes) {
        if (attr.type === "JSXSpreadAttribute") { checkProps(attr.argument); continue; }
        if (attr.type !== "JSXAttribute" || propertyName(attr.name) !== "style" || !attr.value) continue;
        checkStyle(attr.value.type === "JSXExpressionContainer" ? attr.value.expression : attr.value);
      }
    }
    if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression") {
      const target = node.left.object;
      if (target.type === "MemberExpression" && memberName(target) === "style") {
        const name = memberName(node.left);
        if (name === "cssText") checkStyle(node.right);
        else if (name) checkProperty(node, name, node.right, ancestors);
        else add(node.start ?? 0, "UI-21", "Dynamic DOM style properties cannot prove token compliance.");
      }
    }
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
      const method = memberName(node.callee), target = node.callee.object;
      if (method === "setProperty" && target.type === "MemberExpression" && memberName(target) === "style") {
        const [name, value] = node.arguments;
        if (name?.type === "StringLiteral" && value) checkProperty(node, name.value, value);
        else add(node.start ?? 0, "UI-21", "Dynamic DOM style properties cannot prove token compliance.");
      }
      if (method === "setAttribute" && node.arguments[0]?.type === "StringLiteral" && node.arguments[0].value === "style" && node.arguments[1]) checkStyle(node.arguments[1]);
    }
  });
  return violations.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Scan every authored app subtree, including new directories, terminal and tray. */
export function checkUiTree(root: string): UiViolation[] {
  const violations: UiViolation[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(?:css|tsx?|jsx?)$/.test(entry.name)) violations.push(...checkUiSource(normalize(relative(root, path)), readFileSync(path, "utf8")));
    }
  };
  visit(join(root, "app/src"));
  return violations;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !["--source-only", "--evidence-only"].includes(args[0]!))) {
    console.error("Usage: bun scripts/ui-check.ts [--source-only | --evidence-only]");
    process.exit(1);
  }
  const sourceOnly = args[0] === "--source-only";
  const evidenceOnly = args[0] === "--evidence-only";
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (evidenceOnly && !eventPath) {
    console.error("UI PR evidence check requires GITHUB_EVENT_PATH.");
    process.exit(1);
  }
  const violations = evidenceOnly ? [] : checkUiTree(process.cwd());
  for (const violation of violations) console.error(`${violation.path}:${violation.line} [${violation.rule}] ${violation.message}`);
  if (!evidenceOnly) console.log(`UI source check: ${violations.length} violation(s).`);
  const evidenceViolations = !sourceOnly && eventPath ? checkUiPullRequest(eventPath) : [];
  for (const violation of evidenceViolations) console.error(`[${violation.rule}] ${violation.message}`);
  if (!sourceOnly && eventPath) console.log(`UI PR evidence check: ${evidenceViolations.length} violation(s). Metadata requires human review of the linked reports.`);
  if (!sourceOnly && !eventPath) console.log("UI PR evidence: NOT CHECKED. Run bun run ui:ready --pr <number> --ready; see .project/rules/ui.md#ui-review-readiness-procedure.");
  process.exitCode = violations.length || evidenceViolations.length ? 1 : 0;
}
