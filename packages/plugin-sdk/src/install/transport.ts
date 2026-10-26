import type { HostClient } from "../index";
import type { FileInfo } from "../usage";
import type { PreparedPlannerIO, PlannerCommandResult } from "./prepared";

const CHUNK = 262144;
const mode = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const identity = (value: any): value is FileInfo & { mode: number } =>
  value &&
  typeof value.path === "string" &&
  [value.size, value.inode, value.device].every(
    (n) => Number.isSafeInteger(n) && n >= 0,
  ) &&
  Number.isFinite(value.mtimeMs) &&
  mode(value.mode);
const same = (a: FileInfo, b: FileInfo) =>
  identity(b) &&
  a.path === b.path &&
  a.size === b.size &&
  a.inode === b.inode &&
  a.device === b.device &&
  a.mtimeMs === b.mtimeMs &&
  a.mode === b.mode;
const decode = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);

/** Planner images require descriptor-observed mode; old read peers fail closed. */
export function createPlannerIO(
  host: HostClient,
  signal?: AbortSignal,
): PreparedPlannerIO {
  async function output(handle: string): Promise<string> {
    const parts: Buffer[] = [];
    for (let offset = 0; ; ) {
      const value = await host.call<{ base64: string }>(
        "capability.process.outputChunk",
        { handle, offset, length: CHUNK },
      );
      const bytes = Buffer.from(value.base64, "base64");
      if (bytes.length > CHUNK || offset + bytes.length > 1048576)
        throw Error("invalid planner command output");
      parts.push(bytes);
      offset += bytes.length;
      if (bytes.length < CHUNK) return decode(Buffer.concat(parts));
    }
  }
  return {
    signal,
    async read(path) {
      const image = await host.call<any>("capability.fs.read", { path });
      if (image?.missing === true) return null;
      if (!image?.ranged) {
        if (!mode(image?.mode))
          throw Error("planner file image requires observed mode");
        if (typeof image.text !== "string")
          throw Error("invalid planner file image");
        return { text: image.text, mode: image.mode };
      }
      const info = image.ranged;
      if (!identity(info) || info.path !== path)
        throw Error("planner file range requires observed mode and identity");
      const parts: Buffer[] = [];
      for (let offset = 0; offset < info.size; ) {
        const length = Math.min(CHUNK, info.size - offset);
        const value = await host.call<any>("capability.fs.readRange", {
          path,
          offset,
          length,
          expected: info,
        });
        if (typeof value?.base64 !== "string" || !same(info, value.info))
          throw Error("planner file changed during range assembly");
        const bytes = Buffer.from(value.base64, "base64");
        if (bytes.length !== length)
          throw Error("incomplete planner file range");
        parts.push(bytes);
        offset += length;
      }
      return { text: decode(Buffer.concat(parts)), mode: info.mode };
    },
    async run(intent) {
      const value = await host.call<
        PlannerCommandResult & { output?: { stdout: string; stderr: string } }
      >("capability.planner.run", intent);
      if (!value.output) return value;
      return {
        code: value.code,
        stdout: await output(value.output.stdout),
        stderr: await output(value.output.stderr),
      };
    },
  };
}

/** Reassemble only the host's bound-record JSON projection. No path is accepted. */
export async function readPlannerPrior(
  host: HostClient,
  reference: { handle: string; bytes: number },
): Promise<unknown> {
  const { handle, bytes } = structuredClone(reference);
  if (
    typeof handle !== "string" ||
    !handle ||
    handle.length > 256 ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0
  )
    throw Error("invalid planner prior reference");
  const parts: Buffer[] = [];
  for (let offset = 0; offset < bytes; ) {
    const length = Math.min(CHUNK, bytes - offset);
    const value = await host.call<{ base64: string }>(
      "capability.planner.readPriorRange",
      { handle, offset, length },
    );
    if (typeof value?.base64 !== "string")
      throw Error("invalid planner prior range");
    const chunk = Buffer.from(value.base64, "base64");
    if (chunk.length !== length) throw Error("incomplete planner prior range");
    parts.push(chunk);
    offset += length;
  }
  return JSON.parse(decode(Buffer.concat(parts)));
}
