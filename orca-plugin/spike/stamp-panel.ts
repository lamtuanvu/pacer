import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const panelPath = fileURLToPath(new URL("./panel.html", import.meta.url));
const html = await readFile(panelPath, "utf8");
const stamp = /(<p\b[^>]*\bid="stamp"[^>]*>)[\s\S]*?(<\/p>)/;
if (!stamp.test(html)) throw new Error("panel.html has no #stamp paragraph");
const now = new Date().toISOString();
const tmp = `${panelPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
try {
  await writeFile(tmp, html.replace(stamp, `$1${now}$2`), { flag: "wx" });
  await rename(tmp, panelPath);
} finally {
  await unlink(tmp).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
console.log(`Panel stamp: ${now}`);
