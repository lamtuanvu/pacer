import { CoreError } from "../core/errors";
import type { CallAuthority } from "./authority";
import { authorizeHttpUrl } from "./http-authority";
import { BodyTransfers } from "./http-body-transfers";
import { executeHttp, type HttpRequest } from "./http-executor";
import {
  HTTP_BODY_CHUNK_FEATURE,
  HTTP_CAPABILITY_METHODS,
} from "./http-protocol";

export interface HttpTransport {
  features: readonly string[];
  requestFits(params: unknown): boolean;
  resultFits(result: unknown): boolean;
}
const bodies = new BodyTransfers();

/** Caller holds the owner's exclusive window through guarded reply delivery. */
export async function answerHttp(
  authority: CallAuthority,
  method: string,
  input: unknown,
  transport: HttpTransport,
): Promise<unknown> {
  authority.assertGranted("net.http");
  const parsed = HTTP_CAPABILITY_METHODS[method]?.params.safeParse(input);
  if (!parsed?.success)
    throw new CoreError("invalid_input", "invalid HTTP capability parameters");
  const p = parsed.data as Record<string, any>;
  const negotiated = transport.features.includes(HTTP_BODY_CHUNK_FEATURE);
  if (!transport.requestFits(input))
    throw new CoreError(
      "invalid_input",
      "HTTP request metadata exceeds its transport envelope",
    );
  if (method !== "capability.net.http") {
    if (!negotiated)
      throw new CoreError(
        "capability_denied",
        "HTTP body chunks were not negotiated",
      );
    switch (method) {
      case "capability.net.http.body.begin":
        return bodies.begin(authority, p.bytes, true);
      case "capability.net.http.body.stageChunk":
        return bodies.stage(authority, p.handle, p.offset, p.base64);
      case "capability.net.http.body.readChunk":
        return bodies.read(authority, p.handle, p.offset, p.length, (result) =>
          transport.resultFits(result),
        );
      case "capability.net.http.body.release":
        return bodies.release(authority, p.handle);
      default:
        throw new CoreError("unknown_op", "unknown HTTP capability");
    }
  }
  // Admission precedes credential lookup, fetch, and consumption of upload bytes.
  const reservation = await bodies.reserveResponse(authority);
  let reserved = true;
  try {
    const target = await authorizeHttpUrl(authority, p.url);
    const request = { ...p } as HttpRequest;
    if (p.body && typeof p.body === "object") {
      if (!negotiated)
        throw new CoreError(
          "capability_denied",
          "HTTP body chunks were not negotiated",
        );
      request.body = await bodies.consume(authority, p.body.handle);
    }
    const result = await executeHttp(authority, target, request, {
      // Wire metadata was checked above; an uploaded body is not serialized inline.
      requestMetadataFits: () => transport.requestFits(input),
      responseMetadataFits: (metadata) =>
        transport.resultFits({ ...metadata, body: "" }),
    });
    if (transport.resultFits(result)) return result;
    const body = await bodies.publish(
      authority,
      result.body,
      negotiated,
      (descriptor) => transport.resultFits({ ...result, body: descriptor }),
      reservation,
    );
    reserved = false;
    return { ...result, body };
  } finally {
    if (reserved && !authority.signal.aborted)
      await bodies.cancelResponse(authority, reservation);
  }
}
