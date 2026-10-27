export function htmlPreviewDocument(source: string): string {
  const policy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'; navigate-to 'none'";
  let staticSource = source;
  if (typeof document !== "undefined") {
    const template = document.createElement("template");
    template.innerHTML = source;
    for (const element of template.content.querySelectorAll("*")) {
      if (element.tagName === "META" && element.getAttribute("http-equiv")?.toLowerCase() === "refresh") {
        element.remove();
        continue;
      }
      for (const attribute of Array.from(element.attributes)) {
        if (["href", "xlink:href", "action", "formaction", "target"].includes(attribute.name.toLowerCase())) element.removeAttribute(attribute.name);
      }
    }
    staticSource = template.innerHTML;
  }
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">${staticSource}`;
}

export type BlockedKind = "script" | "style" | "img" | "connect" | "frame";
/** A resource the static HTML preview does not load. `local` marks an omitted workspace asset; `inline` marks inline CSS. */
export interface BlockedResource { kind: BlockedKind; address: string; local: boolean; inline?: true }
export const INLINE_STYLES = "inline styles (blocked by app policy)";

/** Attribute names to values, tokenised in order so `src=` inside another quoted value is never read as an attribute. */
function attributes(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of source.matchAll(/([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1]!.toLowerCase();
    if (!found.has(name)) found.set(name, (match[2] ?? match[3] ?? match[4] ?? "").trim());
  }
  return found;
}
function external(address: string): boolean { return /^(?:https?:)?\/\//i.test(address); }
/** Relative or root-relative workspace paths; data:, fragments and other schemes are not assets. */
function localAsset(address: string): boolean {
  return !!address && !address.startsWith("#") && !external(address) && !/^[a-z][\w+.-]*:/i.test(address);
}
// A tag's attribute text may contain ">" inside quoted values.
const tagPattern = /<([a-z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;

/** Lists what the sandboxed preview blocks or omits, from the file text alone (no DOM, no network). */
export function blockedResources(source: string): BlockedResource[] {
  const found: BlockedResource[] = [];
  const seen = new Set<string>();
  const add = (kind: BlockedKind, address: string, local: boolean, inline?: true) => {
    const key = `${kind}\n${address}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(inline ? { kind, address, local, inline } : { kind, address, local });
  };
  const consider = (kind: BlockedKind, address: string | undefined) => {
    if (!address) return;
    if (external(address)) add(kind, address, false);
    else if (localAsset(address)) add(kind, address, true);
  };
  const text = source.replace(/<!--[\s\S]*?-->/g, "");
  const css: string[] = [];
  let inlineStyles = false;
  const markup = text.replace(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)(?:<\/script\s*>|$)/gi, (_whole, attributeText: string, body: string) => {
    const src = attributes(attributeText).get("src");
    if (src) add("script", src, localAsset(src));
    else if (body.trim()) add("script", "inline script", false);
    return "";
  }).replace(/<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi, (_whole, body: string) => {
    if (body.trim()) inlineStyles = true;
    css.push(body);
    return "";
  });
  for (const tag of markup.matchAll(tagPattern)) {
    const name = tag[1]!.toLowerCase(), values = attributes(tag[2] ?? "");
    const style = values.get("style");
    if (style) { inlineStyles = true; css.push(style); }
    if (name === "link") {
      const href = values.get("href");
      const rel = (values.get("rel") ?? "").toLowerCase();
      if (!href) continue;
      if (/\bstylesheet\b/.test(rel)) consider("style", href);
      else if (/\bicon\b/.test(rel)) consider("img", href);
      else if (external(href)) add("connect", href, false);
      continue;
    }
    if (["img", "source", "video", "audio"].includes(name)) consider("img", values.get("src"));
    if (name === "img" || name === "source")
      for (const candidate of (values.get("srcset") ?? "").split(",")) consider("img", candidate.trim().split(/\s+/)[0]);
    if (name === "video") consider("img", values.get("poster"));
    if (name === "iframe" || name === "embed") consider("frame", values.get("src"));
    if (name === "object") consider("frame", values.get("data"));
  }
  for (const block of css) {
    const rest = block.replace(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;?/gi, (_whole, address: string) => {
      consider("style", address);
      return "";
    });
    for (const match of rest.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) consider("img", match[1]);
  }
  if (inlineStyles) add("style", INLINE_STYLES, false, true);
  return found;
}
