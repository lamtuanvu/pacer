# SSH session recording pagination

## Intent

Full remote sessions retain multi-megabyte recordings. The current `SESSION_FILES` SSH script returns all retained files as hex text in one response. The bundled host runner's text RPC is limited to 512 KiB, so routing that script through the plugin unchanged would truncate or refuse valid recordings.

## Approaches

1. Raise the RPC text limit to fit recordings. Rejected: large hex JSON frames would raise memory and transport limits for every plugin call.
2. Fetch a small metadata snapshot, then read each changed file in bounded ranges through the existing `READ_FROM` method. Chosen: it reuses the one-use persisted-run grant and 256 KiB range cap, while preserving the current recording size policy.
3. Add a new staged binary stream. Deferred: it needs a new artifact lifecycle and a larger public protocol surface.

## Contract

The host issues a one-use `SESSION_FILES` metadata grant for one persisted full-session run. The bundled SSH provider runs only the fixed read-only script with the exact run directory. Metadata reports presence, byte length and checksum for retained checkpoint/rotated files, inode plus byte length for the append-only current log, and an independent checksum/length for optional `session.state`. The script stability check excludes `session.state` because active viewers update it independently. The host requests only the stated byte ranges, through one-use `READ_FROM` grants bound to the same run and host. No direct SSH retry is allowed.

The host stages changed files privately. Each poll reads at most 4 MiB and runs for at most 30 seconds, retaining a private staged cursor for the next poll. The cursor is bound to the exact persisted task/run/host fingerprint and metadata generation, limited to 1 GiB and one hour, and discarded on restart drift, rotation or expiry. An incomplete stage holds the run exit pending while leaving the last local files visible. Once all pages are present, the host checks a second metadata snapshot. Checkpoint and rotated log fingerprints must match. The current log must retain its inode and be at least as long as the captured byte length; an appended suffix may be collected on the next poll. `session.state` is best effort: a concurrent state update drops only that staged state value, without blocking stable recording bytes. A rotation, truncation, changed retained file, timeout, malformed response, short range, or output cap refusal leaves the prior local files intact and makes that poll unavailable. The next poll may retry from the last published state.

Publication uses a local transaction journal under the private run directory. Before replacing any visible file, the host durably records the previous file set in a private backup directory and writes a journal marker. It then replaces changed files through restrictive temporary files and atomic per-file renames. If any replacement fails, it restores every previous file from the backup and keeps the poll unavailable. On service restart, the next run observation recovers an unfinished journal before reading or publishing recordings. Only after all replacements succeed does the host remove the marker and backup. Tests inject a failure after the first rename and simulate restart recovery after a partial publish. Session exit is held pending while recording bytes remain undrained.

Existing readers open the fixed recording file names separately and do not share a transaction lock. They may observe an in-progress replacement across two file opens. The journal improves failure and restart recovery; it does not claim atomic multi-file reads for concurrent readers. A later reader-generation migration would be needed for that guarantee.

No new client operation, arbitrary path access or plugin fallback is introduced. The existing `SESSION_FILES` wire script ID stays read-only; the `READ_FROM` stream grammar widens only for four fixed session artifact names when the host has a persisted full-session run. Both methods use the existing `hostRunner.run` protocol shape, so no generated protocol change is needed.

## Validation

Tests cover files larger than one RPC frame, bounded continuation across polls, unchanged files, append-only growth, rotation during paging, continuous state updates, changed checkpoint, malformed/short ranges, journal recovery, disabled provider, and no direct fallback. CT-11 uses a disposable full-session host. A live task that produces only one page does not verify multi-page real SSH delivery; record that surface as UNVERIFIED.
