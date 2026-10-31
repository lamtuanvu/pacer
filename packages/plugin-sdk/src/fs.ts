/** SDK transport only. Paths, credentials and effects remain host-authorized. */
export interface Dependencies {
  call(method: string, params: unknown): Promise<any>;
  cleanupCall?(method: string, params: unknown): Promise<any>;
  fits(method: string, params: unknown): boolean;
  negotiated(): boolean;
  signal?: AbortSignal;
}
const PREFIX = "capability.fs.", MAX = 4194304, CHUNK = 262144;
const fail = (message: string): never => { throw new Error(message); };
export function createFileSystem(d: Dependencies) {
  const active = () => { if (d.signal?.aborted) fail("owning plugin call ended"); };
  const fit = (method: string, params: unknown) => {
    if (!d.fits(PREFIX + method, params)) fail("filesystem complete frame exceeds limit");
  };
  const invoke = async (method: string, params: unknown) => {
    active(); fit(method, params);
    return await d.call(PREFIX + method, params);
  };
  const ok = (reply: any) => { if (reply?.ok !== true) fail("invalid filesystem acknowledgement"); };
  const write = async (path: string, text: string, mode?: 0o600): Promise<void> => {
    active();
    if (mode !== undefined && mode !== 0o600) fail("filesystem write mode must be 0600");
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MAX) fail("filesystem write exceeds 4MiB UTF8");
    const params = { path, text, ...(mode === undefined ? {} : { mode }) };
    if (d.fits(PREFIX + "write", params)) { ok(await invoke("write", params)); active(); return; }
    if (!d.negotiated()) fail("oversized filesystem write requires fileWriteChunks");
    const begin = { path, bytes: bytes.length, ...(mode === undefined ? {} : { mode }) };
    // Reserve worst-case encoded handle metadata before allocating host staging.
    const reserved = "\0".repeat(256);
    fit("beginWrite", begin);
    fit("commitWrite", { handle: reserved });
    fit("releaseWrite", { handle: reserved });
    if (bytes.length) fit("writeChunk", { handle: reserved, offset: MAX, base64: "AA==" });
    let handle: string | undefined, failure: unknown;
    try {
      const opened = await invoke("beginWrite", begin);
      if (typeof opened?.handle !== "string" || !opened.handle || opened.handle.length > 256) fail("invalid filesystem upload handle");
      handle = opened.handle;
      for (let offset = 0; offset < bytes.length;) {
        // Base64 has monotonic encoded size. Adapt to the actual complete frame,
        // including long owner metadata, path-independent handle and current ID.
        let low = 1, high = Math.min(CHUNK, bytes.length - offset), length = 0;
        while (low <= high) {
          const candidate = Math.floor((low + high) / 2);
          const part = bytes.subarray(offset, offset + candidate);
          if (d.fits(PREFIX + "writeChunk", { handle, offset, base64: part.toString("base64") })) {
            length = candidate; low = candidate + 1;
          } else high = candidate - 1;
        }
        if (!length) fail("filesystem complete frame exceeds limit");
        const part = bytes.subarray(offset, offset + length);
        const reply = await invoke("writeChunk", { handle, offset, base64: part.toString("base64") });
        if (reply?.bytes !== offset + length) fail("invalid filesystem byte acknowledgement");
        offset += length;
      }
      ok(await invoke("commitWrite", { handle }));
      handle = undefined; // Successful commit consumes the staging handle.
    } catch (error) { failure = error; }
    if (handle !== undefined) {
      try {
        const release = { handle };
        fit("releaseWrite", release);
        ok(await (d.cleanupCall ?? d.call)(PREFIX + "releaseWrite", release));
      } catch (error) { failure = error; }
    }
    if (failure !== undefined) throw failure;
    active();
  };
  let tail: Promise<void> = Promise.resolve();
  const queue = (action: () => Promise<void>): Promise<void> => {
    if (d.signal?.aborted) return Promise.reject(new Error("owning plugin call ended"));
    let rejectQueued!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectQueued = reject; });
    const abort = () => rejectQueued(new Error("owning plugin call ended"));
    d.signal?.addEventListener("abort", abort, { once: true });
    const operation = tail.then(async () => {
      d.signal?.removeEventListener("abort", abort);
      active();
      await action();
    });
    tail = operation.then(() => undefined, () => undefined);
    return Promise.race([operation, cancelled]);
  };
  return {
    write: (path: string, text: string, mode?: 0o600) => queue(() => write(path, text, mode)),
    mkdir: (path: string) => queue(async () => { ok(await invoke("mkdir", { path })); active(); }),
    remove: (path: string, recursive?: boolean) => queue(async () => {
      ok(await invoke("remove", { path, ...(recursive === undefined ? {} : { recursive }) }));
      active();
    }),
  };
}
