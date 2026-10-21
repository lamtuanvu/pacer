import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { CoreError } from "../core/errors";
export const CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
export const CAPTURE_MAX_DIMENSION = 16384;
export type CaptureMode = "window" | "content";
interface CaptureRequest { request_id: string; client_id: string; window: "main" | "tray"; mode: CaptureMode; expires_at: number; status: "pending" | "claimed" | "complete" | "failed"; image?: Uint8Array; metadata?: CaptureMetadata; error?: string }
export interface DesktopWindow { label: "main" | "tray"; window_id: string; pid: number }
export interface CaptureMetadata { method: CaptureMode; scale: number; width?: number; height?: number }
/** Coordinates owned-window capture; no OS/window implementation or arbitrary paths. */
export class CaptureBroker {
  private workers = new Map<string, { token: string; expires_at: number }>();
  private windows = new Map<string, DesktopWindow[]>();
  private requests = new Map<string, CaptureRequest>();
  constructor(private now: () => number = Date.now) {}
  private prune() {
    for (const [id, request] of this.requests) if (request.expires_at < this.now()) this.requests.delete(id);
    for (const [id, worker] of this.workers) if (worker.expires_at < this.now()) this.workers.delete(id);
  }
  register(client_id: string): string {
    this.prune();
    if (this.workers.size >= 64 && !this.workers.has(client_id)) throw new CoreError("conflict", "Too many desktop capture workers");
    const token = randomBytes(32).toString("hex");
    this.workers.set(client_id, { token, expires_at: this.now() + 60000 }); return token;
  }
  private authorize(client_id: string, token: string) {
    this.prune(); const worker = this.workers.get(client_id);
    if (!worker || !/^[0-9a-f]{64}$/.test(token) || worker.token.length !== token.length || !timingSafeEqual(Buffer.from(worker.token), Buffer.from(token))) throw new CoreError("not_allowed", "Desktop capture worker credential rejected");
    worker.expires_at = this.now() + 60000;
  }
  request(client_id: string, window: string, mode: CaptureMode) {
    this.prune();
    if (window !== "main" && window !== "tray") throw new CoreError("invalid_input", "Only owned main and tray windows can be captured");
    if (mode !== "window" && mode !== "content") throw new CoreError("invalid_input", "Unknown capture mode");
    if (!this.workers.has(client_id)) throw new CoreError("not_found", "Desktop capture worker is unavailable");
    if (this.requests.size >= 16 || [...this.requests.values()].some(request => request.client_id === client_id && ["pending", "claimed"].includes(request.status))) throw new CoreError("conflict", "Desktop capture is busy");
    const request: CaptureRequest = { request_id: randomUUID(), client_id, window, mode, expires_at: this.now() + 60000, status: "pending" };
    this.requests.set(request.request_id, request); return this.publicResult(request);
  }
  targets() { this.prune(); return [...this.workers.keys()].flatMap(client_id => (this.windows.get(client_id) ?? []).map(window => ({ ...window, client_id }))); }
  claim(client_id: string, token: string, windows?: DesktopWindow[]) {
    this.authorize(client_id, token);
    if (windows) this.windows.set(client_id, windows);
    const request = [...this.requests.values()].find(request => request.client_id === client_id && request.status === "pending");
    if (!request) return null;
    request.status = "claimed"; return this.publicResult(request);
  }
  private get(id: string): CaptureRequest {
    this.prune(); const request = this.requests.get(id);
    if (!request) throw new CoreError("not_found", "Desktop capture expired or does not exist"); return request;
  }
  validateUpload(id: string, token: string): void {
    const request = this.get(id); this.authorize(request.client_id, token);
    if (request.status !== "claimed") throw new CoreError("conflict", "Capture is not awaiting completion");
  }
  complete(id: string, token: string, bytes: Uint8Array, metadata: CaptureMetadata) {
    const request = this.get(id); this.authorize(request.client_id, token);
    if (request.status !== "claimed") throw new CoreError("conflict", "Capture is not awaiting completion");
    if (bytes.byteLength > CAPTURE_MAX_BYTES) throw new CoreError("too_large", "Desktop image exceeds 16 MiB");
    const data = Buffer.from(bytes);
    if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || data.toString("ascii",12,16) !== "IHDR") throw new CoreError("invalid_input", "Invalid capture PNG");
    const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
    if (!width || !height || width > CAPTURE_MAX_DIMENSION || height > CAPTURE_MAX_DIMENSION || metadata.method !== request.mode || !Number.isFinite(metadata.scale) || metadata.scale <= 0 || metadata.scale > 8) throw new CoreError("invalid_input", "Capture metadata or geometry is invalid");
    request.status = "complete"; request.image = bytes.slice(); request.metadata = { ...metadata, width, height }; request.expires_at = this.now() + 30000;
    return this.publicResult(request);
  }
  fail(id: string, token: string, message: string) {
    const request = this.get(id); this.authorize(request.client_id, token);
    if (request.status !== "claimed") throw new CoreError("conflict", "Capture is not awaiting completion");
    request.status = "failed"; request.error = message.slice(0, 256); request.expires_at = this.now() + 30000;
    return this.publicResult(request);
  }
  result(id: string) { return this.publicResult(this.get(id)); }
  image(id: string): Uint8Array {
    const request = this.get(id); if (request.status !== "complete" || !request.image) throw new CoreError("conflict", "Capture image is not ready"); return request.image;
  }
  private publicResult({ image: _image, ...request }: CaptureRequest) { return request; }
}
const brokers = new Map<string, CaptureBroker>();
export function captureBroker(pacerHome: string): CaptureBroker {
  let broker = brokers.get(pacerHome); if (!broker) { broker = new CaptureBroker(); brokers.set(pacerHome, broker); } return broker;
}
export function resetCaptureBroker(pacerHome: string): void { brokers.delete(pacerHome); }
