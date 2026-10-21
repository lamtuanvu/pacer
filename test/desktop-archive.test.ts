import { expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { inspectDesktopArchive } from "../scripts/release/desktop-verify";

async function archive(extra: Record<string, string>) {
  return new Uint8Array(await (await new Bun.Archive({ ...Object.fromEntries([1, 2, 3, 4, 5].map(n => [`pacer.app/file${n}`, "fixture"])), ...extra }, { compress: "gzip" }).blob()).arrayBuffer());
}
test("unsafe archive roots and paths fail before app inspection", async () => {
  for (const path of ["outside/file", "pacer.app/../escape", "pacer.app/path\\escape"]) {
    let calls = 0;
    await expect(inspectDesktopArchive(await archive({ [path]: "bad" }), async () => { calls++; })).rejects.toThrow();
    expect(calls).toBe(0);
  }
});
test("symlink archive payload is refused and private extraction is removed after successful inspection", async () => {
  const root = tmpDir(), app = join(root, "pacer.app"); mkdirSync(app);
  for (let i = 0; i < 5; i++) writeFileSync(join(app, `file${i}`), "fixture");
  symlinkSync("file0", join(app, "redirect"));
  const p = Bun.spawnSync(["tar", "--format=ustar", "-czf", join(root, "fixture.tar.gz"), "-C", root, "pacer.app"]);
  expect(p.exitCode).toBe(0);
  await expect(inspectDesktopArchive(new Uint8Array(await Bun.file(join(root, "fixture.tar.gz")).arrayBuffer()), async () => {})).rejects.toThrow("resource");
  let extracted = "";
  expect(await inspectDesktopArchive(await archive({}), async app => { extracted = app; expect(existsSync(app)).toBe(true); return "checked"; })).toBe("checked");
  expect(existsSync(extracted)).toBe(false);
});

function tarHeader(path: string, type = "0", payload = "fixture", link = "") {
  const header = Buffer.alloc(512); header.write(path, 0, 100, "utf8");
  const octal = (offset: number, length: number, value: number) => header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
  octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, Buffer.byteLength(payload)); octal(136, 12, 0);
  header.fill(32, 148, 156); header.write(type, 156); header.write(link, 157, 100); header.write("ustar\0", 257); header.write("00", 263);
  const sum = header.reduce((a, b) => a + b, 0); header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  const bytes = Buffer.alloc(Math.ceil(Buffer.byteLength(payload) / 512) * 512); bytes.write(payload);
  return Buffer.concat([header, bytes]);
}
test("raw tar headers reject every link, special entry, duplicate and trailing nonzero before extraction", async () => {
  const { gzipSync } = await import("node:zlib");
  const { spyOn } = await import("bun:test");
  const base = [1, 2, 3, 4, 5].map(n => tarHeader(`pacer.app/file${n}`));
  const extract = spyOn(Bun.Archive.prototype, "extract");
  const outside = join(tmpDir(), "outside"); writeFileSync(outside, "unchanged");
  try {
    for (const entry of [tarHeader("pacer.app/link", "2", "", outside), tarHeader("pacer.app/hard", "1", "", outside), tarHeader("pacer.app/pipe", "6", ""), tarHeader("pacer.app/device", "3", ""), tarHeader("pacer.app/file1"), tarHeader("pacer.app/dir/", "5", ""), tarHeader("pacer.app/x", "x", "path=../outside")]) {
      const entries = entry[156] === 53 ? [...base, entry, tarHeader("pacer.app/dir", "5", "")] : [...base, entry];
      await expect(inspectDesktopArchive(gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])), async () => {})).rejects.toThrow();
    }
    await expect(inspectDesktopArchive(gzipSync(Buffer.concat([...base, Buffer.alloc(1024), Buffer.from("bad")])), async () => {})).rejects.toThrow();
    expect(extract).not.toHaveBeenCalled();
    expect(await Bun.file(outside).text()).toBe("unchanged");
  } finally { extract.mockRestore(); }
});
