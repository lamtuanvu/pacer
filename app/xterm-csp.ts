import type { BunPlugin } from 'bun';

/** xterm 6.0.0's DOM cell renderer bypasses documentOverride and writes style
 * attributes. Convert that one upstream write to CSSOM at build time. Fail closed
 * if an upgrade changes it, rather than silently shipping CSP violations.
 * Source: src/browser/renderer/dom/DomRendererRowFactory.ts, _addStyle (MIT).
 */
export const xtermCsp: BunPlugin = {
  name: 'xterm-csp',
  setup(build) {
    build.onLoad({ filter: /[/\\]@xterm[/\\]xterm[/\\]lib[/\\]xterm\.(mjs|js)$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const pattern = /_addStyle\((\w+),(\w+)\)\{\1\.setAttribute\("style",`\$\{\1\.getAttribute\("style"\)\|\|""\}\$\{\2\};`\)\}/g;
      let matches = 0;
      const contents = source.replace(pattern, (_match, element, style) => {
        matches++;
        return `_addStyle(${element},${style}){${element}.style.cssText+=${style}+";"}`;
      });
      if (matches !== 1) throw Error('xterm CSP adapter needs review after dependency change');
      return { contents, loader: 'js' };
    });
  },
};
