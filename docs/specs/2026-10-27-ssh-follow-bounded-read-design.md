# Bounded remote viewer reads

## Context

Before this migration, an attached viewer started a direct, long-lived SSH `FOLLOW` child to tail `session.raw`. The bundled SSH provider serves host-issued `READ_FROM` ranges for the same persisted run, capped at 256 KiB per grant. The separate `hostRunner.stream` method now has a bounded progress and acknowledgement contract.

## Decision

While a viewer is attached, read `session.raw` through one-use `READ_FROM` grants starting at the remote recording's committed byte cursor. Each read requests at most 256 KiB and the registry checks the provider's hex output and range bound. Consecutive empty reads back off from 200 ms to 2 s. This wait is in addition to SSH and plugin round-trip time; interactive updates may arrive later than the direct tail. No second SSH path is tried after provider refusal.

The viewer keeps at most one read in flight. Its abort controller cancels the provider call on detach, close or service exit. On a successful result, it serializes recording publication with the ordinary run poll. If the poll advanced the cursor during the read, the viewer discards that stale range and starts from the new cursor; this avoids duplicate bytes. It sends only bytes that the recording mirror accepted and preserves snapshot/resync and read-only viewer behavior. Reconnect resumes at the current cursor; a failed read leaves the cursor unchanged for the next observation.

The `FOLLOW` script ID was removed before 1.7.0 shipped. The bidirectional `SESSION_PIPE` bridge now runs through the bundled SSH provider.

Each empty PTY read opens a short SSH command, so idle viewers add local and remote process load. Consecutive empty reads back off from 200 ms to 2 s; data resets the delay.

## Validation

Tests cover live output delivery, reconnect from cursor, simultaneous ordinary poll and viewer read, cancel/detach, malformed/timeout/disabled-provider refusal, and absence of direct SSH fallback. CT-11 uses the approved disposable remote full-session task through the guarded live harness and checks attached viewer output where the public fixture allows it. Unexercised real viewer edges remain UNVERIFIED.
