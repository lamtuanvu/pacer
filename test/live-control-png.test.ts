import { expect, test } from "bun:test";
import { validatePng } from "../src/desktop/png";
const png = new Uint8Array(await Bun.file(`${import.meta.dir}/fixtures/live-control/one-pixel.png`).arrayBuffer());
test("validates complete PNG bytes and rejects corrupt, truncated and oversized decoded data", () => {
  expect(validatePng(png)).toMatchObject({ width: 1, height: 1 });
  expect(() => validatePng(png.slice(0, 24))).toThrow();
  const corrupt = png.slice(); corrupt[corrupt.length - 1] ^= 1;
  expect(() => validatePng(corrupt)).toThrow();
  expect(() => validatePng(new Uint8Array(16 * 1024 * 1024 + 1))).toThrow();
});
