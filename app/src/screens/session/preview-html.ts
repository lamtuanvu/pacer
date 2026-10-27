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
/** A resource the static HTML preview does not load. `local` marks an omitted workspace asset. */
export interface BlockedResource { kind: BlockedKind; address: string; local: boolean }

const attributePattern = (name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
function attribute(attributes: string, name: string): string | undefined {
  const match = attributePattern(name).exec(attributes);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "").trim() : undefined;
}
function external(address: string): boolean { return /^(?:https?:)?\/\//i.test(address); }
/** Relative or root-relative workspace paths; data:, fragments and other schemes are not assets. */
function localAsset(address: string): boolean {
  return !!address && !address.startsWith("#") && !external(address) && !/^[a-z][\w+.-]*:/i.test(address);
}

/** Lists what the sandboxed preview blocks or omits, from the file text alone (no DOM, no network). */
export function blockedResources(source: string): BlockedResource[] {
  const found: BlockedResource[] = [];
  const seen = new Set<string>();
  const add = (kind: BlockedKind, address: string, local: boolean) => {
    const key = `${kind}\n${address}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ kind, address, local });
  };
  const consider = (kind: BlockedKind, address: string | undefined) => {
    if (!address) return;
    if (external(address)) add(kind, address, false);
    else if (localAsset(address)) add(kind, address, true);
  };
  const text = source.replace(/<!--[\s\S]*?-->/g, "");
  const css: string[] = [];
  const markup = text.replace(/<script\b([^>]*)>([\s\S]*?)(?:<\/script\s*>|$)/gi, (_whole, attributes: string, body: string) => {
    const src = attribute(attributes, "src");
    if (src) add("script", src, localAsset(src));
    else if (body.trim()) add("script", "inline script", false);
    return "";
  }).replace(/<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi, (_whole, body: string) => { css.push(body); return ""; });
  for (const tag of markup.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const name = tag[1]!.toLowerCase(), attributes = tag[2] ?? "";
    const style = attribute(attributes, "style");
    if (style) css.push(style);
    if (name === "link") {
      const href = attribute(attributes, "href");
      const rel = (attribute(attributes, "rel") ?? "").toLowerCase();
      if (!href) continue;
      if (/\bstylesheet\b/.test(rel)) consider("style", href);
      else if (/\bicon\b/.test(rel)) consider("img", href);
      else if (external(href)) add("connect", href, false);
    } else if (name === "img" || name === "source") consider("img", attribute(attributes, "src"));
    else if (name === "iframe") consider("frame", attribute(attributes, "src"));
  }
  for (const block of css) {
    const rest = block.replace(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;?/gi, (_whole, address: string) => {
      consider("style", address);
      return "";
    });
    for (const match of rest.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) consider("img", match[1]);
  }
  return found;
}
