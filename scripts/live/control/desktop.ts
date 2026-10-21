import { captureMetadataSchema } from "../../../src/desktop/capture-contract";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, checkout, type Session } from "../core";
import { ControlError, MAX_IMAGE_BYTES, type Action, type CaptureResult, type Observation, type SurfaceAdapter, type Target } from "./contract";
import type { OperationContext } from "./deadline";
import { acquireLease, processIdentity, sameProcess } from "./lease";

async function helperPath(): Promise<string> {
  if (process.platform !== "darwin") throw new ControlError("unsupported_capability", "native desktop control requires macOS");
  const source = join(checkout, "scripts/live/native/main.swift");
  const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
  const directory = join(checkout, ".work/live-tools"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "pacer-native-control");
  const fingerprint = `${path}.source-hash`;
  if (!existsSync(path) || !existsSync(fingerprint) || readFileSync(fingerprint, "utf8") !== hash) {
    const child = Bun.spawn(["/usr/bin/swiftc", "-parse-as-library", source, "-o", `${path}.tmp-${process.pid}`], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 60000);
    const error = await new Response(child.stderr).text(); const code = await child.exited; clearTimeout(timer);
    if (code) throw new ControlError("observer_unavailable", `native helper compilation failed: ${error.slice(0, 1000)}`);
    const { renameSync } = await import("node:fs"); renameSync(`${path}.tmp-${process.pid}`, path);
    atomicWrite(fingerprint, hash);
  }
  return path;
}
export async function nativeCommand(request: Record<string, unknown>, clock?: OperationContext): Promise<any> {
  clock?.check();
  const path = await helperPath();
  clock?.check();
  request = { ...request, deadline_ms: clock?.deadline_ms ?? Date.now() + 10000 };
  const child = Bun.spawn([path], { stdin: new TextEncoder().encode(JSON.stringify(request)), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), clock?.remaining() ?? 10000);
  try {
    const output = await new Response(child.stdout).text();
    if (output.length > MAX_IMAGE_BYTES * 1.4 + 1024 * 1024) throw new ControlError("capture_invalid", "native result too large");
    const status = await child.exited;
    if (status) throw new ControlError("observer_unavailable", "native observer terminated", request.command === "act" ? "unknown" : undefined);
    const result = JSON.parse(output);
    if (!result.ok) throw new ControlError(result.error?.code ?? "observer_unavailable", result.error?.message ?? "native request failed", request.command === "act" ? "not_delivered" : undefined);
    return result.result;
  } finally { clearTimeout(timer); }
}
export async function createDesktopAdapter(session: Session): Promise<SurfaceAdapter> {
  if (!session.desktopPid || !session.desktopIdentity) throw new ControlError("target_unavailable", "launch a desktop owned by this live session");
  const identity = session.desktopIdentity;
  async function verify() { if (!await sameProcess(identity)) throw new ControlError("stale_reference", "owned desktop process exited or restarted"); }
  const snapshots = new Map<string, Observation>();
  async function targets(clock?: OperationContext): Promise<Target[]> {
    await verify();
    const result = await nativeCommand({ command: "targets", pid: identity.pid, start_identity: identity.start_identity }, clock);
    let reported: Array<{window_id: string; label: "main" | "tray"; pid: number; client_id: string}> = [];
    try { reported = await serviceOp(session, "desktop.capture.targets", {}); } catch { /* Older releases use external observation with explicit native IDs. */ }
    return result.windows.map((window: {window_id: string; title: string; bounds: {X: number; Y: number; Width: number; Height: number}}): Target => ({
      id: reported.find(entry => entry.pid === identity.pid && entry.window_id === window.window_id)?.label ?? `window-${window.window_id}`,
      client_id: reported.find(entry => entry.pid === identity.pid && entry.window_id === window.window_id)?.client_id,
      native_label: reported.find(entry => entry.pid === identity.pid && entry.window_id === window.window_id)?.label, surface: "desktop", pid: identity.pid, start_identity: identity.start_identity,
      bounds: { x: window.bounds.X, y: window.bounds.Y, width: window.bounds.Width, height: window.bounds.Height },
      window_id: window.window_id, generation: `${identity.start_identity}:${window.window_id}`,
      capabilities: ["inspect", "click", "type", "key", "select", "resize", "scroll", "activate", "capture"],
    }));
  }
  async function inspect(target: Target, clock?: OperationContext): Promise<Observation> {
    await verify();
    const value = await nativeCommand({ command: "inspect", pid: identity.pid, start_identity: identity.start_identity, window_id: target.window_id }, clock);
    const revision = createHash("sha256").update(JSON.stringify([target.generation, value])).digest("hex").slice(0, 24);
    const observation = { target, revision, elements: value.elements, truncated: value.truncated };
    snapshots.set(target.id, observation); return observation;
  }
  return {
    targets, inspect,
    act: async (target: Target, action: Action, clock?: OperationContext) => {
      await verify();
      const current = await inspect(target, clock);
      clock?.check();
      if (action.ref && (action.revision !== current.revision || action.generation !== target.generation)) throw new ControlError("stale_reference", "native control changed", "not_delivered");
      if (action.x !== undefined || action.y !== undefined) {
        if (!action.capture_id || !/^[a-zA-Z0-9_-]{1,128}$/.test(action.capture_id)) throw new ControlError("invalid_input", "coordinate action requires capture ID", "not_delivered");
        const step = JSON.parse(readFileSync(join(session.root, "evidence/steps", `${action.capture_id}.json`), "utf8"));
        const image = step.artifacts?.find((entry: {id: string}) => entry.id === action.capture_id);
        if (!image || step.target?.window_id !== target.window_id || step.target?.generation !== target.generation || JSON.stringify(image.bounds) !== JSON.stringify(target.bounds) || Date.now() - Date.parse(image.at) > 10000) throw new ControlError("stale_reference", "coordinate capture no longer matches window", "not_delivered");
        if (action.x! < 0 || action.y! < 0 || action.x! >= image.width || action.y! >= image.height) throw new ControlError("invalid_input", "coordinates outside screenshot", "not_delivered");
        const x = target.bounds!.x + action.x! * target.bounds!.width / image.width;
        const y = target.bounds!.y + action.y! * target.bounds!.height / image.height;
        return nativeCommand({ command: "act", pid: identity.pid, start_identity: identity.start_identity, window_id: target.window_id, expected_bounds: target.bounds, action: { ...action, x, y } }, clock);
      }
      return nativeCommand({ command: "act", pid: identity.pid, start_identity: identity.start_identity, window_id: target.window_id, action }, clock);
    },
    capture: async (target, mode, _captureId, clock): Promise<CaptureResult> => {
      await verify();
      try {
        if (!target.native_label) throw new ControlError("capture_unavailable", "desktop did not report a label for this native window");
        return await selfCapture(session, mode, target.native_label, target.client_id, target.window_id, clock);
      }
      catch (error) {
        // Window evidence may fall back to external window capture. Never substitute content.
        if (mode !== "window") throw error;
        const capture = await nativeCommand({ command: "capture", pid: identity.pid, start_identity: identity.start_identity, window_id: target.window_id }, clock);
        return { method: "external-window", bytes: Buffer.from(capture.png, "base64"), mime: "image/png", width: capture.width, height: capture.height, scale: capture.scale, warnings: [{ code: "self_capture_unavailable", message: String(error) }] };
      }
    }, close: async () => {},
  };
}
async function serviceOp(session: Session, name: string, params: unknown, clock?: OperationContext): Promise<any> {
  const origin = `http://127.0.0.1:${session.port}`;
  const token = readFileSync(join(session.root, "home/token"), "utf8").trim();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: origin, "X-Pacer-Client": "app" };
  {
    const response = await fetch(`${origin}/v3/ops/${name}`, { method: "POST", headers, body: JSON.stringify(params), signal: clock?.signal ?? AbortSignal.timeout(10000) });
    const body = await response.json() as any;
    if (!response.ok) throw new ControlError(body.error?.code ?? "observer_unavailable", "desktop self-capture request failed");
    return body.result;
  }
}
async function selfCapture(session: Session, mode: "window" | "content", window: "main" | "tray", clientId?: string, windowId?: string, clock?: OperationContext): Promise<CaptureResult> {
  const op = (name: string, params: unknown) => serviceOp(session, name, params, clock);
  const origin = `http://127.0.0.1:${session.port}`;
  const token = readFileSync(join(session.root, "home/token"), "utf8").trim();
  const headers = { Authorization: `Bearer ${token}` };
  const clients = await op("client.list", {});
  const desktops = clients.filter((client: {kind: string; client_id: string}) => client.kind === "desktop" && (!clientId || client.client_id === clientId));
  if (desktops.length !== 1) throw new ControlError("ambiguous", "expected exactly one sandbox desktop capture worker");
  const request = await op("desktop.capture.request", { client_id: desktops[0].client_id, window, mode, window_id: windowId });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    clock?.check();
    const result = await op("desktop.capture.result", { request_id: request.request_id });
    if (result.status === "failed") throw new ControlError("capture_unavailable", result.error);
    if (result.status === "complete") {
      const response = await fetch(`${origin}/v3/desktop/capture/${request.request_id}/image`, { headers, signal: clock?.signal ?? AbortSignal.timeout(10000) });
      if (!response.ok) throw new ControlError("capture_unavailable", "desktop image download failed");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const producer = captureMetadataSchema.parse(result.metadata);
      if (producer.window_id !== windowId || producer.pid !== session.desktopPid || producer.app_sha256 !== session.desktopSha256)
        throw new ControlError("capture_invalid", "capture producer does not match the owned desktop build and window");
      return { method: mode, bytes, mime: "image/png", width: producer.width, height: producer.height, scale: producer.scale, producer };
    }
    await Bun.sleep(100);
  }
  throw new ControlError("capture_unavailable", "desktop self-capture timed out");
}
