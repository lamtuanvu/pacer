// Placeholder bundle. A later app build replaces these embedded files.
export const APP_VERSION = "0.0.0";
export const APP_FILES: { path: string; type: string; text: string }[] = [
  {
    path: "index.html", type: "text/html; charset=utf-8",
    text: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>pacer app</title><script src="/app/app.js" defer></script></head><body><h1>pacer app — coming soon</h1><p id="version">Loading pacer version…</p></body></html>',
  },
  {
    path: "app.js", type: "text/javascript; charset=utf-8",
    text: 'fetch("/v2/hello").then(r => { if (!r.ok) throw Error("Session ended. Run `pacer open`."); return r.json(); }).then(hello => { document.getElementById("version").textContent = "pacer " + hello.pacer; }).catch(error => { document.getElementById("version").textContent = error.message; });',
  },
];
