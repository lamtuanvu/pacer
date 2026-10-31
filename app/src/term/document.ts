/** xterm's documented documentOverride scopes its generated styles to the page's
 * CSP nonce. Do not patch the global document or allow arbitrary inline styles. */
export function terminalDocument(document: Document, nonce: string): Document {
  return new Proxy(document, {
    get(target, key) {
      if (key === "createElement") return (tag: string, options?: ElementCreationOptions) => {
        const element = target.createElement(tag, options);
        if (tag.toLowerCase() === "style") element.nonce = nonce;
        // xterm 6's Viewport uses window.document for its stylesheet, but
        // appends it to a screen created here. Authorize it before insertion.
        const appendChild = element.appendChild;
        element.appendChild = function<T extends Node>(child: T): T {
          if (child instanceof HTMLStyleElement) child.nonce = nonce;
          return appendChild.call(this, child) as T;
        };
        return element;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
