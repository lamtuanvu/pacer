# SQLite contention and startup readiness

The user approved preventing a repeat of database-lock failures and desktop
sign-in timeouts. Isolated fixtures reproduce unnecessary reader writer-locks,
filesystem work inside import transactions and first-settle backfill delaying
listener startup. The exact historical lock holder on the affected machine is
not proven; heavy memory pressure was observed but is not an established root
cause for every failure.

The fix keeps offline CLI and older binary compatibility. Existing schemas are
read without a migration transaction. Import scans and parsing precede bounded
64-record commit batches with SQL revision/mtime guards. First-settle history extraction also precedes bounded insert batches. Historical backfill and
daily retention run in one service-owned child at a time, after listener startup.
The child uses the same source/compiled core, receives the selected isolated
home in tests and no internal transport credentials, and exits when the parent
pipe closes. Shutdown cancels pending work. Temporary SQLite busy errors receive
three bounded retries; other failures stay visible in service diagnostics.

Alternatives were a longer startup deadline (does not remove contention) and
routing every independent runner/offline CLI write through the service (a broader
compatibility migration). This patch uses shorter critical sections and process
isolation. It leaves ordinary mutation busy-timeout behavior, authentication,
public protocol, task revisions and the non-destructive JSON window unchanged.
No task files may be moved or deleted as a recovery shortcut.

Verification requires real writer-lock fixtures, old JSON revision recovery,
concurrent updates, non-busy error propagation and a live harness run that checks
service sign-in and reads under contention. Report every unavailable surface as
UNVERIFIED; a healthy process alone does not prove API responsiveness.
