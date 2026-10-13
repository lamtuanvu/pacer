import { style } from "./style";
import { mark } from "./icons";
const steps = `<ol><li>In Orca Settings &gt; Plugins, uninstall this pacer (installed from the marketplace).</li><li>Under Development, add <code>~/.pacer/orca-plugin</code>, the folder pacer prepared for you; the notification shows its full path.</li><li>Enable pacer.</li></ol>`;
export function renderBootstrapPanel(): string {
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><title>Set up pacer</title><style>${style}</style></head><body><main class="view"><div class="content">
 <header class="brand">${mark}<strong>Set up pacer</strong></header>
 <p>pacer installs and starts in the background. A notification says when it is ready.</p>
 <section><h2>One-time setup</h2>${steps}</section>
 <p class="muted">Orca only refreshes plugin panels added as a development folder, so the live budget panel runs from there.</p>
 </div></main></body></html>`;
}
