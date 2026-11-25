/** Shared outcomes for the fixed parent helper channel. Kept dependency-free so
 * the FFI layer, the spawner, the adapter and the provider can all classify a
 * refusal without importing each other. */
export type NativeHelperErrorKind = "refused" | "retired";
export class NativeHelperError extends Error {
  constructor(
    public readonly kind: NativeHelperErrorKind,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NativeHelperError";
  }
}
/** A clean E refusal: the parent channel is intact and remains usable. */
export const helperRefused = (message = "Native parent helper launch was refused") =>
  new NativeHelperError("refused", message);
/** A retired or broken parent channel: no further spawn can succeed on it. */
export const helperRetired = (message = "Native parent helper channel is retired", cause?: unknown) =>
  new NativeHelperError("retired", message, cause);
