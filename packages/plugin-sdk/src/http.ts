/** PRIVATE SDK candidate: transport only, no host authority/network implementation. */
export interface Request {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  authorization?: { secretRef: string; scheme?: string };
}
export interface Response {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface Dependencies {
  call(method: string, params: unknown): Promise<any>;
  cleanupCall?(method: string, params: unknown): Promise<any>;
  /** Exact complete JSON-RPC envelope including actual reserved ID, metadata and newline. */
  fits(method: string, params: unknown): boolean;
  negotiated(): boolean;
  signal?: AbortSignal;
}
const BODY = 4194304,
  CHUNK = 262144,
  HTTP = "capability.net.http",
  PREFIX = HTTP + ".body.";
const fail = (message: string): never => {
  throw new Error(message);
};
export function createHttp(d: Dependencies) {
  const active = () => {
    if (d.signal?.aborted) fail("owning plugin call ended");
  };
  const fit = (method: string, params: unknown) => {
    if (!d.fits(method, params)) fail("HTTP complete frame exceeds limit");
  };
  const invoke = async (method: string, params: unknown) => {
    active();
    fit(method, params);
    return await d.call(method, params);
  };
  const execute = async (request: Request): Promise<Response> => {
    active();
    const bytes =
      request.body === undefined
        ? undefined
        : Buffer.from(request.body, "utf8");
    if (bytes && bytes.length > BODY) fail("HTTP body exceeds 4MiB UTF8");
    let upload: string | undefined, download: string | undefined;
    let result: Response | undefined;
    let failure: unknown;
    try {
      let wire: unknown = request;
      if (!d.fits(HTTP, request)) {
        if (!bytes || !d.negotiated())
          throw new Error("HTTP oversized request requires httpBodyChunks");
        // Protocol handles are <=256chars. Reserve the maximum encoded handle
        // before begin so metadata cannot fail after publishing an upload.
        fit(HTTP, { ...request, body: { handle: "\0".repeat(256) } });
        fit(PREFIX + "begin", { bytes: bytes.length });
        const opened = await invoke(PREFIX + "begin", { bytes: bytes.length });
        if (
          typeof opened?.handle !== "string" ||
          !opened.handle ||
          opened.handle.length > 256
        )
          fail("invalid HTTP upload handle");
        upload = opened.handle;
        wire = { ...request, body: { handle: upload } };
        fit(HTTP, wire);
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          const part = bytes.subarray(offset, offset + CHUNK);
          const ack = await invoke(PREFIX + "stageChunk", {
            handle: upload,
            offset,
            base64: part.toString("base64"),
          });
          if (ack?.bytes !== offset + part.length)
            fail("invalid HTTP upload acknowledgement");
        }
      }
      const reply = await invoke(HTTP, wire);
      let body = reply?.body;
      if (typeof body !== "string") {
        if (
          !d.negotiated() ||
          typeof body?.handle !== "string" ||
          !body.handle ||
          body.handle.length > 256 ||
          !Number.isSafeInteger(body.bytes) ||
          body.bytes < 0 ||
          body.bytes > BODY
        )
          fail("invalid HTTP response body descriptor");
        download = body.handle;
        const chunks: Buffer[] = [];
        for (let offset = 0; offset < body.bytes; ) {
          const length = Math.min(CHUNK, body.bytes - offset);
          const part = await invoke(PREFIX + "readChunk", {
            handle: download,
            offset,
            length,
          });
          if (typeof part?.base64 !== "string") fail("invalid HTTP body chunk");
          const decoded = Buffer.from(part.base64, "base64");
          if (
            decoded.length !== length ||
            decoded.toString("base64") !== part.base64
          )
            fail("invalid HTTP body chunk");
          chunks.push(decoded);
          offset += decoded.length;
        }
        body = Buffer.concat(chunks).toString("utf8");
      }
      if (Buffer.byteLength(body, "utf8") > BODY)
        fail("decoded HTTP response exceeds 4MiB UTF8");
      result = { status: reply.status, headers: reply.headers, body };
    } catch (error) {
      failure = error;
    }
    // Cleanup is awaited even after cancellation; the injected call retains the
    // original ownership metadata. A cleanup failure cannot become success.
    for (const handle of new Set(
      [download, upload].filter((v): v is string => v !== undefined),
    )) {
      try {
        const params = { handle };
        fit(PREFIX + "release", params);
        await (d.cleanupCall ?? d.call)(PREFIX + "release", params);
      } catch (error) {
        failure = error;
      }
    }
    if (failure !== undefined) throw failure;
    active();
    return result!;
  };
  // One complete helper transaction at a time per hostFor/owning-call client.
  // Waiting creates no new deadline: the injected absolute owner signal applies.
  let tail: Promise<void> = Promise.resolve();
  return (request: Request): Promise<Response> => {
    if (d.signal?.aborted)
      return Promise.reject(new Error("owning plugin call ended"));
    let rejectQueued: ((error: Error) => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectQueued = reject;
    });
    const abort = () => rejectQueued?.(new Error("owning plugin call ended"));
    d.signal?.addEventListener("abort", abort, { once: true });
    const operation = tail.then(async () => {
      // Abort races only the QUEUED phase. Once admitted, execute must await
      // release/cleanup before settling and before the next transaction starts.
      d.signal?.removeEventListener("abort", abort);
      return execute(request);
    });
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return Promise.race([operation, cancelled]);
  };
}
