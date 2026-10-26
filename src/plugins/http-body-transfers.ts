/** Owning-call HTTP payload transfers. The broker validates scopes and reflection before publication. */
import { randomUUID } from "node:crypto";
import { CallAuthority } from "./authority";
import { CoreError } from "../core/errors";
const MAX = 4194304,
  CHUNK = 262144;
interface Payload {
  handle: string;
  buffer: Buffer;
  offset: number;
}
interface State {
  upload?: Payload;
  response?: Payload;
  reservation?: object;
  retired: Set<string>;
}
const deny = () =>
  new CoreError(
    "capability_denied",
    "HTTP body handle does not belong to this active operation",
  );
function integer(value: number, max: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max)
    throw new CoreError("invalid_input", "invalid HTTP body byte bound");
}
/** One pending upload and one pending response per owner; sequential transactions reuse both slots. */
export class BodyTransfers {
  private states = new WeakMap<CallAuthority, State>();
  private state(a: CallAuthority): State {
    if (!(a instanceof CallAuthority)) throw deny();
    a.assertGranted("net.http");
    let s = this.states.get(a);
    if (s) return s;
    s = { retired: new Set() };
    const owned = s;
    a.onRevoke(() => {
      owned.upload?.buffer.fill(0);
      owned.response?.buffer.fill(0);
      owned.upload = undefined;
      owned.response = undefined;
      owned.reservation = undefined;
      owned.retired.clear();
      this.states.delete(a);
    });
    this.states.set(a, s);
    return s;
  }
  private feature(ok: boolean) {
    if (ok !== true)
      throw new CoreError(
        "capability_denied",
        "HTTP body chunks were not negotiated",
      );
  }
  async begin(
    a: CallAuthority,
    bytes: number,
    negotiated: boolean,
  ): Promise<{ handle: string }> {
    const s = this.state(a);
    this.feature(negotiated);
    integer(bytes, MAX);
    if (s.upload)
      throw new CoreError(
        "conflict",
        "release or consume the pending HTTP upload first",
      );
    const handle = randomUUID();
    s.upload = { handle, buffer: Buffer.alloc(bytes), offset: 0 };
    return { handle };
  }
  async stage(
    a: CallAuthority,
    handle: string,
    offset: number,
    base64: string,
  ): Promise<{ bytes: number }> {
    const s = this.state(a),
      u = s.upload;
    if (!u || u.handle !== handle) throw deny();
    integer(offset, MAX);
    if (typeof base64 !== "string" || base64.length > 349528)
      throw new CoreError("invalid_input", "invalid HTTP body chunk");
    const bytes = Buffer.from(base64, "base64");
    if (
      bytes.length > CHUNK ||
      bytes.toString("base64") !== base64 ||
      offset !== u.offset ||
      offset + bytes.length > u.buffer.length
    )
      throw new CoreError(
        "invalid_input",
        "invalid HTTP body chunk sequence or encoding",
      );
    bytes.copy(u.buffer, offset);
    u.offset += bytes.length;
    return { bytes: u.offset };
  }
  async consume(a: CallAuthority, handle: string): Promise<string> {
    const s = this.state(a),
      u = s.upload;
    if (!u || u.handle !== handle) throw deny();
    if (u.offset !== u.buffer.length)
      throw new CoreError("invalid_input", "HTTP upload is incomplete");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        u.buffer,
      );
    } catch {
      throw new CoreError("invalid_input", "HTTP upload is not UTF8 text");
    }
    u.buffer.fill(0);
    s.upload = undefined;
    s.retired.add(handle);
    return text;
  }
  async reserveResponse(a: CallAuthority): Promise<object> {
    const s = this.state(a);
    if (s.response || s.reservation)
      throw new CoreError(
        "conflict",
        "release the pending HTTP response first",
      );
    const token = Object.freeze({});
    s.reservation = token;
    return token;
  }
  async cancelResponse(a: CallAuthority, token: object): Promise<void> {
    const s = this.state(a);
    if (s.reservation !== token) throw deny();
    s.reservation = undefined;
  }
  async publish(
    a: CallAuthority,
    text: string,
    negotiated: boolean,
    fits: (d: { handle: string; bytes: number }) => boolean,
    reservation?: object,
  ): Promise<{ handle: string; bytes: number }> {
    const s = this.state(a);
    this.feature(negotiated);
    if (typeof text !== "string")
      throw new CoreError("invalid_input", "HTTP response must be text");
    const length = Buffer.byteLength(text, "utf8");
    integer(length, MAX);
    if (reservation !== undefined && s.reservation !== reservation)
      throw deny();
    if (s.response || (s.reservation && s.reservation !== reservation))
      throw new CoreError(
        "conflict",
        "release the pending HTTP response first",
      );
    const descriptor = Object.freeze({ handle: randomUUID(), bytes: length });
    if (!fits(descriptor))
      throw new CoreError(
        "invalid_input",
        "HTTP response metadata exceeds its transport envelope",
      );
    a.assertGranted("net.http");
    if (reservation !== undefined && s.reservation !== reservation)
      throw deny();
    if (s.response || (s.reservation && s.reservation !== reservation))
      throw new CoreError(
        "conflict",
        "HTTP response capacity changed during serialization",
      );
    s.reservation = undefined;
    s.response = {
      handle: descriptor.handle,
      buffer: Buffer.from(text, "utf8"),
      offset: 0,
    };
    return descriptor;
  }
  async read(
    a: CallAuthority,
    handle: string,
    offset: number,
    length: number,
    fits: (result: { base64: string }) => boolean = () => true,
  ): Promise<{ base64: string }> {
    const s = this.state(a),
      r = s.response;
    if (!r || r.handle !== handle) throw deny();
    integer(offset, MAX);
    integer(length, CHUNK);
    if (offset !== r.offset || offset > r.buffer.length)
      throw new CoreError(
        "invalid_input",
        "invalid HTTP response chunk sequence",
      );
    const end = Math.min(r.buffer.length, offset + length);
    const result = {
      base64: r.buffer.subarray(offset, end).toString("base64"),
    };
    if (!fits(result))
      throw new CoreError(
        "invalid_input",
        "HTTP chunk reply exceeds its transport envelope",
      );
    a.assertGranted("net.http");
    if (s.response !== r || r.offset !== offset)
      throw new CoreError(
        "conflict",
        "HTTP response changed during serialization",
      );
    r.offset = end;
    return result;
  }
  async release(a: CallAuthority, handle: string): Promise<{ ok: true }> {
    const s = this.state(a);
    if (s.upload?.handle === handle) {
      s.upload.buffer.fill(0);
      s.upload = undefined;
      s.retired.add(handle);
      return { ok: true };
    }
    if (s.response?.handle === handle) {
      s.response.buffer.fill(0);
      s.response = undefined;
      s.retired.add(handle);
      return { ok: true };
    }
    if (s.retired.has(handle)) return { ok: true };
    throw deny();
  }
}
