/** Local-only brand renderer. Requires Bun and Chrome; never runs in CI/tests. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dir, "../..");
const assets = join(root, ".github/assets");
// Override for another platform/install; no machine-specific paths are persisted.
const chrome = process.env.CHROME_BIN ?? (process.platform === "darwin"
  ? join("/", "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")
  : "google-chrome");
const scratch = await mkdtemp(join(tmpdir(), "pacer-brand-"));
const font = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
function mark(dark: boolean) {
  return `<rect x="4" y="20" width="40" height="8" rx="4" fill="${dark ? "#52525B" : "#E4E4E7"}"/><rect x="4" y="20" width="22" height="8" rx="4" fill="${dark ? "#FFFFFF" : "#18181B"}"/><rect x="29" y="12" width="4" height="24" rx="2" fill="${dark ? "#A3E635" : "#65A30D"}"/>`;
}
async function capture(source: string, output: string, width: number, height: number, scale: number, dark = false) {
  const profile = await mkdtemp(join(scratch, "chrome-"));
  const proc = Bun.spawn([chrome, "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profile}`, `--screenshot=${output}`, `--window-size=${width},${height}`,
    "--hide-scrollbars", `--force-device-scale-factor=${scale}`, "--virtual-time-budget=1000",
    "--lang=en-US", ...(dark ? ["--force-dark-mode"] : []), pathToFileURL(source).href],
    {stdout: "ignore", stderr: "pipe", env: {...process.env, TZ: "UTC"}});
  const stderr = await new Response(proc.stderr).text();
  if (await proc.exited !== 0) throw new Error(`Chrome capture failed: ${stderr}`);
  // Chrome's PNG encoding already produces small files; enforce the delivery limit.
  const bytes = await readFile(output);
  if (bytes.length > 300 * 1024) throw new Error(`${output} exceeds 300 KiB`);
  console.log(`${output.slice(root.length + 1)} (${Math.round(bytes.length / 1024)} KiB)`);
}
try {
  await mkdir(assets, {recursive: true});
  for (const dark of [false, true]) {
    const logo = `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="pacer" viewBox="0 0 240 64"><svg x="0" y="8" width="48" height="48" viewBox="0 0 48 48">${mark(dark)}</svg><text x="60" y="46" fill="${dark ? "#FFFFFF" : "#18181B"}" style="font-family:${font};font-size:44px;font-weight:650;letter-spacing:-.03em">pacer</text></svg>\n`;
    await writeFile(join(assets, `pacer-logo-${dark ? "dark" : "light"}.svg`), logo);
  }
  const social = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>pacer social preview</title><style>
*{box-sizing:border-box}body{margin:0;width:1280px;height:640px;background:#FAFAFA;color:#18181B;font-family:${font};overflow:hidden}.content{position:absolute;left:180px;top:156px;width:920px}.identity{display:flex;align-items:center;gap:24px}.wordmark{font-size:108px;font-weight:650;letter-spacing:-.04em;line-height:1.1}p{margin:28px 0 0;font-size:32px;letter-spacing:-.02em;color:#52525B}.lane{position:absolute;left:180px;top:464px;width:920px;height:12px;border-radius:999px;background:#E4E4E7}.used{width:42%;height:100%;border-radius:999px;background:#D4D4D8}.tick{position:absolute;left:57%;top:-8px;width:4px;height:28px;border-radius:2px;background:#65A30D}
</style></head><body><main class="content"><div class="identity"><svg aria-label="pacer pace marker" role="img" width="120" height="120" viewBox="0 0 48 48">${mark(false)}</svg><span class="wordmark">pacer</span></div><p>Subscription budgets for AI coding agents</p></main><div class="lane" aria-hidden="true"><div class="used"></div><div class="tick"></div></div></body></html>\n`;
  const socialPath = join(assets, "social-preview.html");
  await writeFile(socialPath, social);
  await capture(socialPath, join(assets, "social-preview.png"), 1280, 640, 1);
} finally {
  await rm(scratch, {recursive: true, force: true});
}
