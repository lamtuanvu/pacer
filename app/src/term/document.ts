/** xterm's documented documentOverride scopes its generated styles to the page's
 * CSP nonce. Do not patch the global document or allow arbitrary inline styles. */
export function terminalDocument(document: Document, nonce: string): Document {
  return new Proxy(document, {
    get(target, key) {
      if (key === "createElement") return (tag: string, options?: ElementCreationOptions) => {
        const element = target.createElement(tag, options);
        if (tag.toLowerCase() === "style") element.nonce = nonce;
        return element;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
