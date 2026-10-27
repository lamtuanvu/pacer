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
