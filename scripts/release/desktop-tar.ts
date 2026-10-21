/** Validate raw POSIX USTAR headers before any filesystem extraction. Extended formats fail closed. */
export function validateDesktopTar(tar: Uint8Array): void {
  if (tar.byteLength % 512 || tar.byteLength < 1536) throw Error("Invalid desktop tar framing");
  const decoder = new TextDecoder("utf-8", { fatal: true }), seen = new Map<string, boolean>();
  const text = (bytes: Uint8Array) => decoder.decode(bytes.subarray(0, bytes.indexOf(0) < 0 ? undefined : bytes.indexOf(0)));
  const octal = (bytes: Uint8Array) => {
    const value = new TextDecoder().decode(bytes).replace(/[\0 ]+$/g, "").replace(/^ +/, "");
    if (!/^[0-7]+$/.test(value)) throw Error("Invalid desktop tar numeric field");
    const n = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(n) || n < 0) throw Error("Invalid desktop tar size");
    return n;
  };
  let offset = 0, regular = 0, terminated = false;
  while (offset < tar.byteLength) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every(byte => byte === 0)) {
      if (tar.byteLength - offset < 1024 || !tar.subarray(offset).every(byte => byte === 0)) throw Error("Invalid desktop tar terminator");
      terminated = true; break;
    }
    if (decoder.decode(h.subarray(257, 263)) !== "ustar\0" || decoder.decode(h.subarray(263, 265)) !== "00") throw Error("Desktop archive requires POSIX USTAR");
    const checksum = h.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (octal(h.subarray(148, 156)) !== checksum) throw Error("Desktop tar header checksum mismatch");
    const type = h[156], directory = type === 53;
    if (type !== 0 && type !== 48 && !directory) throw Error("Unsupported desktop archive resource type");
    if (text(h.subarray(157, 257))) throw Error("Desktop archive links are forbidden");
    const prefix = text(h.subarray(345, 500)), name = text(h.subarray(0, 100));
    let path = prefix ? `${prefix}/${name}` : name;
    if (directory && path.endsWith("/")) path = path.slice(0, -1);
    if ((path !== "pacer.app" && !path.startsWith("pacer.app/")) || (!directory && path === "pacer.app") || path.includes("\\") || path.split("/").some(p => p === "." || p === ".." || !p)) throw Error("Desktop archive contains an unsafe path");
    if (seen.has(path)) throw Error("Duplicate desktop archive path");
    seen.set(path, directory);
    if (seen.size > 20000) throw Error("Too many desktop archive entries");
    const size = octal(h.subarray(124, 136));
    if ((directory && size !== 0) || size > 1024 * 1024 * 1024) throw Error("Invalid desktop archive entry size");
    if (!directory) regular++;
    offset += 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(offset) || offset > tar.byteLength) throw Error("Truncated desktop archive entry");
  }
  if (!terminated || regular < 5) throw Error("Incomplete desktop archive");
  const paths = [...seen.keys()].sort();
  for (let i = 0; i < paths.length - 1; i++) if (!seen.get(paths[i]) && paths[i + 1].startsWith(paths[i] + "/")) throw Error("Desktop archive file/directory conflict");
}
