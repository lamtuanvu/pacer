import { style } from "./style";
import { mark } from "./icons";
const steps = `<ol><li>In Orca Settings &gt; Plugins, uninstall this pacer (installed from the marketplace).</li><li>Under Development, add <code>~/.pacer/orca-plugin</code>, the folder pacer prepared for you.</li><li>Enable pacer.</li></ol>`;
export function renderBootstrapPanel(): string {
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><title>Set up pacer</title><style>${style}</style></head><body><main class="view"><div class="content">
 <header class="brand">${mark}<strong>Set up pacer</strong></header>
 <p id="activity" role="status"><span class="console-spinner" aria-hidden="true">◐</span> <span id="activity-text">Installing pacer in the background… 0:00</span></p>
 <p>pacer opens in a <strong>pacer</strong> terminal tab when it is ready. Closed it? Run <code>pacer dashboard</code> in any terminal.</p>
 <details><summary>Prefer the sidebar panel?</summary>${steps}</details>
 <p class="muted">Orca only refreshes plugin panels added as a development folder, so the live budget panel runs from there.</p>
 </div></main><script>
// The panel can't see the worker's progress; this only shows that work is under way since the panel opened.
const opened = Date.now(), text = document.getElementById("activity-text"), spinner = document.querySelector("#activity .console-spinner");
const timer = setInterval(() => {
 const s = Math.floor((Date.now() - opened) / 1000);
 if (s < 120) { text.textContent = "Installing pacer in the background… " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); return; }
 clearInterval(timer); spinner.hidden = true;
 text.textContent = "Taking longer than usual. If no notification appeared, run ~/.local/bin/pacer --version in a terminal to check.";
}, 1000);
</script></body></html>`;
}
