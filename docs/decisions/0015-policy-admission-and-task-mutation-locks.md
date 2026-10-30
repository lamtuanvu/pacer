# Policy admission and task mutation locks

Status: accepted 2026-10-30 with the M0 SP02–SP07 integration (#494).

## Context

Policy evaluation waits for another process. Task creation, retry, review and
session operations also wait for repository checks and native preparation.
An authorization result can become stale during any of those waits.

The task store uses cross-process operation locks and a process-local marker for
synchronous reentrant writes. Holding that marker across an await would allow
another request in the same process to mistake an unrelated write for a
reentrant write. Holding only the file lock across an await is also insufficient:
a same-process synchronous writer can block the event loop waiting for the file
lock, preventing the asynchronous owner from completing its check.

This refines the existing [task-store decision](2026-10-19-sqlite-task-store.md)
under P2 and the approved plugin extraction policy boundary. It changes no
public protocol, plugin grant or filesystem authority.

## Decision

Perform plugin policy calls before taking task mutation or slot locks, and before
opening a SQLite mutation transaction. Retain operation admission while policy
is pending. A veto or cancellation must leave creation, attachment claims, retry
links, reservations and session resets untouched.

A prepared creation authorization is single use. Its final consumption performs
a fresh bounded repository identity check against the identity originally
authorized; it cannot adopt a replacement repository. It then checks current
policy generation, task revision, eligibility and grant expiry immediately before
a synchronous effect. Callers cannot separate the final check from that effect
with another await or a contended lock acquisition.

For mutations of an existing task, acquire its operation file lock
asynchronously before the final bounded repository check. Record a separate
process-local preparation state during that check. Synchronous writers in the
same process must return a conflict while preparation is active instead of
blocking the event loop or treating themselves as reentrant. Other asynchronous
writers may wait for the operation lock. Cross-process writers retain the
existing file-lock discipline.

Enable the reentrant marker only for the final synchronous mutation callback.
No plugin call or SQLite transaction spans asynchronous preparation. Failure,
timeout, cancellation and callback exceptions must release preparation state,
reentrant state, the operation lock and any unlaunched admission lease.

Session creation uses its existing creation serialization and attachment
transaction, with the same prepared authorization consumed immediately around
its synchronous store effects. Existing-task session resume and retry use the
task preparation discipline. Request-id replay remains checked before policy
and at final admission, so an identical concurrent request cannot create or
launch twice.

The Core HTTP dispatcher carries the request abort signal together with any
trusted upstream signal and deadline in an internal operation context. These
values are never accepted from JSON parameters. Pending admission consumes that
lifetime; admitted work runs independently. Detached runner and plugin process
contexts and retained read owners discard it, while each pending plugin call
keeps its own cancellation signal. The stdio EOF contract still drains pending
requests; no new public cancellation notification is introduced here.

## Policy outcomes and failure modes

A policy may only restrict. The maintainer confirmed this rule on 2026-10-30:
- **Veto** refuses the action. A veto on one queued task holds that task with a recorded reason and does not stop the queue drain.
- **Amend** may change the task kind, may move placement only to a new worktree, and may never change the executor the dispatcher chose or lower isolation. Any other amendment is rejected and recorded.
- **Allow** leaves the action unchanged.

`plugins.policy.mode` sets the failure behavior. In `closed` mode, an unavailable, ungranted or failing policy plugin refuses or holds the action with a visible diagnostic. In `open` mode the action proceeds, and each ignored failure writes a `policy` warning with the plugin id and reason.

## Limits and validation

Task locks serialize Pacer writers; they do not freeze the repository namespace
against unrelated filesystem actors. Execution-time filesystem access must keep
its own identity and scope checks. Policy authorization does not grant a new
filesystem handle, executor work grant or native control identity.

Validation must exercise repository replacement after policy and during lock
contention, same-process writer conflicts without event-loop starvation,
cross-process serialization, synchronous reentrant writes, cancellation and
failure cleanup, and unchanged behavior with no configured policies. These
requirements are not recorded here as passing results. Independent review and
source-bound live validation remain required before completion.
