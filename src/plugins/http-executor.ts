/** HTTP executor; the broker owns exclusive authority and guarded delivery. */
import { CoreError } from "../core/errors";
import type { CallAuthority } from "./authority";
import { authorizedHttpUrl, resolveHttpSecret } from "./http-authority";
export interface HttpRequest {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  authorization?: { secretRef: string; scheme?: string };
}
export interface TrustedControls {
  requestMetadataFits: (request: HttpRequest) => boolean;
  responseMetadataFits: (response: {
    status: number;
    headers: Record<string, string>;
  }) => boolean;
  fetch?: typeof fetch;
}
const MAX = 4 * 1024 * 1024;
const invalid = () =>
  new CoreError(
    "invalid_input",
    "HTTP request or response exceeds its validated contract",
  );
const network = () =>
  new CoreError("plugin_unavailable", "HTTP request failed");
export async function executeHttp(
  authority: CallAuthority,
  target: unknown,
  input: HttpRequest,
  controls: TrustedControls,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const started = Date.now(),
    url = authorizedHttpUrl(authority, target);
  let request: HttpRequest, headers: Headers;
  try {
    request = structuredClone(input);
    if (new URL(request.url).href !== url)
      throw new CoreError(
        "capability_denied",
        "HTTP request does not match admitted target",
      );
    if (
      !["GET", "POST", "PUT", "DELETE"].includes(request.method) ||
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs <= 0 ||
      request.timeoutMs > 120000 ||
      (request.body !== undefined &&
        (typeof request.body !== "string" ||
          Buffer.byteLength(request.body) > MAX))
    )
      throw invalid();
    if (
      request.headers !== undefined &&
      (!request.headers ||
        typeof request.headers !== "object" ||
        Array.isArray(request.headers) ||
        Object.values(request.headers).some((v) => typeof v !== "string"))
    )
      throw invalid();
    headers = new Headers(request.headers);
    if (request.authorization) {
      if (
        typeof request.authorization.secretRef !== "string" ||
        (request.authorization.scheme !== undefined &&
          typeof request.authorization.scheme !== "string")
      )
        throw invalid();
      // Validate header syntax before resolving any credential; never log this temporary value.
      new Headers({
        authorization:
          (request.authorization.scheme ?? "Bearer") + " placeholder",
      });
    }
    let metadataFits: boolean;
    try {
      metadataFits = controls.requestMetadataFits(request);
    } catch {
      throw invalid();
    }
    if (metadataFits !== true) throw invalid();
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw invalid();
  }
  authority.assertActive();
  const deadline = Math.min(started + request.timeoutMs, authority.deadlineMs);
  const controller = new AbortController();
  const timeout = new CoreError(
    "plugin_timeout",
    "HTTP request deadline expired",
  );
  const cleanupError = new CoreError(
    "plugin_unavailable",
    "HTTP cleanup could not be confirmed",
  );
  let completed!: () => void;
  const settled = new Promise<void>((resolve) => {
    completed = resolve;
  });
  let cleanupFailure: CoreError | undefined;
  const detach = authority.onRevoke(async () => {
    await settled;
    if (cleanupFailure) throw cleanupFailure;
  });
  const abort = () => controller.abort(authority.signal.reason);
  authority.signal.addEventListener("abort", abort, { once: true });
  const parentDeadline = authority.deadlineMs <= started + request.timeoutMs;
  const expire = () => {
    controller.abort(timeout);
    if (parentDeadline) void authority.revoke(timeout).catch(() => {});
  };
  const timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
  function guard() {
    if (Date.now() >= deadline) {
      expire();
      throw timeout;
    }
    if (authority.signal.aborted) {
      if (
        authority.signal.reason instanceof CoreError &&
        authority.signal.reason.code === "plugin_timeout"
      )
        throw timeout;
      throw new CoreError("capability_denied", "HTTP owning call was revoked");
    }
    authority.assertGranted("net.http");
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    complete = false,
    readFailed = false,
    readFailure: unknown;
  let closed: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
  let result:
      | { status: number; headers: Record<string, string>; body: string }
      | undefined,
    failure: unknown;
  try {
    guard();
    let injected: string | null = null;
    if (request.authorization) {
      injected = await resolveHttpSecret(
        authority,
        target,
        request.authorization.secretRef,
      );
      if (!injected)
        throw new CoreError(
          "invalid_input",
          "HTTP authorization reference is absent",
        );
      try {
        headers.set(
          "authorization",
          (request.authorization.scheme ?? "Bearer") + " " + injected,
        );
      } catch {
        throw invalid();
      }
    }
    guard();
    let response: Response;
    try {
      response = await (controls.fetch ?? fetch)(url, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      guard();
      throw network();
    }
    reader = response.body?.getReader();
    // Observe settlement immediately, but never await an open stream before cancellation.
    if (reader)
      closed = reader.closed.then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error }),
      );
    guard();
    if (response.status >= 300 && response.status < 400)
      throw new CoreError("capability_denied", "HTTP redirects are refused");
    const responseHeaders = Object.fromEntries(response.headers.entries());
    if (
      injected &&
      Object.entries(responseHeaders).some(
        ([k, v]) => k.includes(injected!) || v.includes(injected!),
      )
    )
      throw new CoreError(
        "capability_denied",
        "HTTP response exposed an injected credential",
        undefined,
        { reason: "credential_reflection" },
      );
    let metadataFits: boolean;
    try {
      metadataFits = controls.responseMetadataFits({
        status: response.status,
        headers: responseHeaders,
      });
    } catch {
      throw invalid();
    }
    if (metadataFits !== true) throw invalid();
    guard();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader)
      for (;;) {
        const next = await reader.read().catch((error) => {
          readFailed = true;
          readFailure = error;
          guard();
          throw network();
        });
        guard();
        if (next.done) {
          complete = true;
          break;
        }
        bytes += next.value.byteLength;
        if (bytes > MAX) throw invalid();
        chunks.push(next.value);
      }
    else complete = true;
    const body = Buffer.concat(chunks).toString("utf8");
    if (Buffer.byteLength(body) > MAX) throw invalid();
    if (injected && body.includes(injected))
      throw new CoreError(
        "capability_denied",
        "HTTP response exposed an injected credential",
        undefined,
        { reason: "credential_reflection" },
      );
    guard();
    result = { status: response.status, headers: responseHeaders, body };
  } catch (error) {
    failure = error instanceof CoreError ? error : network();
  } finally {
    if (reader) {
      let cancellationFailed = false,
        cancellationError: unknown;
      if (!complete) {
        try {
          await reader.cancel();
        } catch (error) {
          cancellationFailed = true;
          cancellationError = error;
        }
      }
      const outcome = await closed!;
      // Only the identical error of an already errored stream is discharged.
      // A cancel hook can close the stream successfully and still reject with an unrelated AbortError.
      if (
        cancellationFailed &&
        !(readFailed && cancellationError === readFailure) &&
        !(!outcome.ok && outcome.error === cancellationError)
      )
        cleanupFailure = cleanupError;
      reader.releaseLock();
    }
    clearTimeout(timer);
    authority.signal.removeEventListener("abort", abort);
    if (cleanupFailure) {
      void authority.revoke(cleanupFailure).catch(() => {});
    } else detach();
    completed();
  }
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  return result!;
}
