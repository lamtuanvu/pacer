import { xtermCsp } from "./xterm-csp";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import { generateTokensCss, generateTokensTs, readTokens } from "./tokens-gen";

/** app.js gzip budget from the UI implementation spec (60 KB, without the terminal chunk). */
export const APP_JS_BUDGET = 60 * 1024;
export const TERM_JS_BUDGET = 150 * 1024;
export interface AppFile { path: string; type: string; text: string }
const root = import.meta.dir;

/** Pure with respect to the filesystem: tests compare without rewriting checked-in assets. */
export async function buildApp(target: "browser" | "desktop" = "browser"): Promise<AppFile[]> {
  const result = await Bun.build({ plugins: [xtermCsp], entrypoints: [join(root, "src/app.tsx"), join(root, "src/term/term.tsx"), join(root, "src/screens/setup/Setup.tsx"), join(root, "src/shell/UpdateNotice.tsx"), join(root, "src/screens/dispatch/Dispatch.tsx"), join(root, "src/screens/insights/Insights.tsx"), join(root, "src/shell/CommandPalette.tsx"), join(root, "src/screens/new-task/NewTask.tsx")], splitting: true, naming: { entry: "[name].js", chunk: "chunk-[hash].js" }, target: "browser", minify: true, sourcemap: "none", tsconfig: join(root, "tsconfig.json") });
  if (!result.success) throw new AggregateError(result.logs, "app build failed");
  const tray = await Bun.build({ entrypoints: [join(root, "src/tray/main.tsx")], target: "browser", minify: true, sourcemap: "none", tsconfig: join(root, "tsconfig.json") });
  if (!tray.success) throw new AggregateError(tray.logs, "tray build failed");
  const css = [generateTokensCss(readTokens(join(root, "src/ds"))), await Bun.file(join(root, "src/ds/components.css")).text(), await Bun.file(join(root, "src/ds/feedback.css")).text(), await Bun.file(join(root, "src/styles.css")).text(), await Bun.file(join(root, "src/screens/insights/insights.css")).text(), await Bun.file(join(root, "src/screens/session/session.css")).text(), await Bun.file(join(root, "src/screens/session/file-viewer.css")).text(), await Bun.file(join(root, "src/screens/terminal/terminal.css")).text(), await Bun.file(join(root, "src/screens/work/work.css")).text(), await Bun.file(join(root, "src/screens/new-task/new-task.css")).text(), await Bun.file(join(root, "src/shell/assistant/assistant.css")).text(), await Bun.file(join(root, "src/screens/trace/trace.css")).text(), await Bun.file(join(root, "src/screens/workspace/workspace.css")).text(), await Bun.file(join(root, "src/screens/review/result-page.css")).text(), await Bun.file(join(root, "src/ds/native.css")).text()].join("\n");
  const files: AppFile[] = [
    { path: "index.html", type: "text/html; charset=utf-8", text: await Bun.file(join(root, "index.html")).text() },
    { path: "app.js", type: "text/javascript; charset=utf-8", text: await result.outputs.find(output => output.path.endsWith("/app.js"))!.text() },
    { path: "app.css", type: "text/css; charset=utf-8", text: css },
    ...await Promise.all(result.outputs.filter(output => !output.path.endsWith("/app.js")).map(async output => ({ path: output.path.split("/").pop()!, type: "text/javascript; charset=utf-8", text: await output.text() }))),
    { path: "term.css", type: "text/css; charset=utf-8", text: await Bun.file(join(root, "../node_modules/@xterm/xterm/css/xterm.css")).text() },
    { path: "tray.html", type: "text/html; charset=utf-8", text: await Bun.file(join(root, "src/tray/tray.html")).text() },
    { path: "tray.js", type: "text/javascript; charset=utf-8", text: await tray.outputs[0]!.text() },
    { path: "tray.css", type: "text/css; charset=utf-8", text: [generateTokensCss(readTokens(join(root, "src/ds"))), await Bun.file(join(root, "src/ds/components.css")).text(), await Bun.file(join(root, "src/ds/feedback.css")).text(), await Bun.file(join(root, "src/tray/tray.css")).text(), await Bun.file(join(root, "src/ds/native.css")).text()].join("\n") },
  ];
  if (target === "desktop") {
    for (const file of files) if (file.path.endsWith('.html')) {
      file.text = file.text.replaceAll('/app/', './').replace('</head>', '<meta name="pacer-style-nonce" content="__TAURI_STYLE_NONCE__"><style></style></head>');
    }
    // Keep the proven startup/recovery controls as states inside the persistent document.
    // Shadow DOM scopes their existing selectors and CSS away from the workbench.
    const shellMarkup = (await Bun.file(join(root, '../desktop/ui/index.html')).text()).split('<body>')[1]!.split('</body>')[0]!;
    const shellStyles = (await Bun.file(join(root, '../desktop/ui/shell.css')).text()).replaceAll(':root', ':host').replace(/^body(?=\s*\{)/gm, '.shell-body');
    const bootstrap = `const host=window.document.getElementById('desktop-shell');const root=host.attachShadow({mode:'open'});root.innerHTML=${JSON.stringify('<div class="shell-body">'+shellMarkup+'</div>')};const style=window.document.createElement('style');style.nonce=window.document.querySelector('meta[name="pacer-style-nonce"]').content;style.textContent=${JSON.stringify(shellStyles)};root.prepend(style);const body=root.querySelector('.shell-body');const document=new Proxy(window.document,{get(target,key){if(key==='body')return body;if(key==='querySelector')return root.querySelector.bind(root);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});`;
    const shellScript = await Bun.file(join(root, '../desktop/ui/shell.js')).text();
    files.push({path:'shell-state.js',type:'text/javascript; charset=utf-8',text:'{'+bootstrap+shellScript+'}'});
    files.push({path:'mark.svg',type:'image/svg+xml',text:await Bun.file(join(root,'../desktop/ui/mark.svg')).text()});
    for (const file of files.filter(file=>file.path.endsWith('.html'))) file.text=file.text.replace('<body>', '<body><div id="desktop-shell"></div><script src="./shell-state.js" defer></script>');
    files.push({path: "service-guidance.html", type: "text/html; charset=utf-8", text: await Bun.file(join(root, "../desktop/ui/service-guidance.html")).text()});
    files.push({path: "service-guidance.css", type: "text/css; charset=utf-8", text: await Bun.file(join(root, "../desktop/ui/service-guidance.css")).text()});
    // Existing lazy terminal assets resolve under /app; keep that alias bundled.
    files.push({ ...files.find(file => file.path === 'term.css')!, path: 'app/term.css' });
  }
  return files;
}
export function generatedSource(files: AppFile[]): string {
  return `// Generated by app/build.ts. Do not edit.\nexport const APP_VERSION = ${JSON.stringify(pkg.version)};\nexport const APP_FILES: { path: string; type: string; text: string }[] = ${JSON.stringify(files, null, 2)};\n`;
}
if (import.meta.main) {
  // The startup shell bundles tokens without loading the service app's CSS.
  const shellPath = join(root, "../desktop/ui/shell.css");
  const shellCss = await Bun.file(shellPath).text();
  const shellMarker = "/* Bundled copy of app/src/ds/tokens.css above; keep in sync with the pacer tokens. */";
  const shellSuffixAt = shellCss.indexOf(shellMarker);
  if (shellSuffixAt < 0) throw new Error("Desktop shell CSS token boundary marker is missing; refusing to overwrite handwritten styles.");
  const desktopOnly = process.argv.includes("--desktop-only");
  const files = desktopOnly ? [] : await buildApp();
  const desktopFiles = await buildApp("desktop");
  rmSync(join(root,"dist/desktop"), {recursive:true,force:true});
  for (const file of desktopFiles) await Bun.write(join(root, "dist/desktop", file.path), file.text);
  mkdirSync(join(root, "dist"), { recursive: true });
  const tokens = readTokens(join(root, "src/ds"));
  const tokenCss = generateTokensCss(tokens);
  if (!desktopOnly) {
    await Bun.write(join(root, "src/ds/tokens.css"), tokenCss);
    await Bun.write(shellPath, tokenCss + shellCss.slice(shellSuffixAt));
    await Bun.write(join(root, "src/ds/tokens.ts"), generateTokensTs(tokens));
  }
  for (const file of files) await Bun.write(join(root, "dist", file.path), file.text);
  if (!desktopOnly && !process.argv.includes("--no-embed")) await Bun.write(join(root, "../src/app/assets.generated.ts"), generatedSource(files));
  for (const file of [...files, ...desktopFiles].filter(file => file.path.endsWith(".js"))) {
    const size = Bun.gzipSync(file.text).byteLength;
    const budget = file.path === "app.js" ? APP_JS_BUDGET : TERM_JS_BUDGET;
    if (size >= budget) throw new Error(`${file.path} exceeds gzip budget (${size}/${budget})`);
    console.log(`${file.path}: ${size} bytes gzip (budget ${budget})`);
  }

}
