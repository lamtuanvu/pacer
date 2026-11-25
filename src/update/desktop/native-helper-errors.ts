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

/** A bundled helper (or its staging) failed signature/hash/process verification.
 *  Distinct from a missing session: fail closed, but never report it as a network hiccup. */
export class NativeHelperIntegrityError extends Error {
  constructor(message = "Desktop update helper failed integrity verification", cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NativeHelperIntegrityError";
  }
}
export const helperIntegrity = (message?: string, cause?: unknown) =>
  new NativeHelperIntegrityError(message, cause);

/** A local storage/permission failure while staging the helper under PACER_HOME
 *  (disk full, read-only or unwritable data folder, I/O error). Fail closed, but
 *  never report it as a tampered helper or as a transient network check. */
export class NativeHelperStorageError extends Error {
  constructor(message = "Desktop update helper could not be staged because of a local storage failure", cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NativeHelperStorageError";
  }
}
export const helperStorage = (message?: string, cause?: unknown) =>
  new NativeHelperStorageError(message, cause);

/** A post-mkdir staging refusal: the pacer data folder, not the signed app, has
 *  unexpected ownership or permissions. Still integrity (fail closed), but the
 *  remedy is to fix the folder rather than reinstall pacer. */
export class NativeHelperDataFolderError extends NativeHelperIntegrityError {
  constructor(message = "pacer's data folder has unexpected permissions", cause?: unknown) {
    super(message, cause);
    this.name = "NativeHelperDataFolderError";
  }
}
export const helperDataFolder = (message?: string, cause?: unknown) =>
  new NativeHelperDataFolderError(message, cause);
