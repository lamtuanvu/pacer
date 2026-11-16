# Task: native msg.send live answers — review fixes (v2)

Executor: codex. No time limit; finish both items, checks, live validation and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-native-msg-live-answer (branch fix/native-msg-live-answer), head e25482db2 on origin/main 445241520. Read .work/reviews/fix-native-msg-live-answer-handoff.md (your previous work) and the independent review .work/reviews/fix-native-msg-live-answer-review.md (verdict FAIL). Same rules as before (AGENTS.md; RUST-7 parity; CT-11; sign commits with `git commit -s`; do not push).

## 1. Blocking: legacy duplicate redelivery reaches native answer code
Review finding 1: `crates/messaging-ops/src/msg_ops.rs:77` routes on the incoming kind/reply_to only, but `msg_writes.rs:508` matches a prior message with a NULL fingerprint (`msg_writes.rs:349`; `src/messaging/store.ts:26` migrates old rows to NULL). A send with the same caller and request_id can resolve to a previously stored answer; TypeScript `duplicate` (`src/messaging/send.ts:125`) routes that stored answer through `directAnswerTarget`, native `duplicate` does not.
Fix: whenever the native send path would act on a stored prior message that is an answer with a reply_to (the duplicate/redelivery path), hand the original request to Core before any native side effect, using the existing selective-forward mechanism the native handlers already use (find how other handlers signal "forward this request" mid-handler, e.g. dispatch planning or config writes; reuse it). If no such mechanism exists for msg.send, route in `msg_ops.rs` by looking up request_id → stored kind before choosing native, with a read-only lookup. Add a front-door parity case (native vs forwarded) with a legacy NULL-fingerprint stored answer and a duplicate request_id, in test/native-msg-live-answer-parity.test.ts. It must fail before the fix (save output to .work/fixtures/).

## 2. CT-11 live evidence for the waiting interactive session
Build a live-harness fixture that produces a synthetic interactive run waiting on a question, modeled on the parity test's synthetic run, ViewerHub socket and task state (no real executor). Find the harness seeds/fixtures under scripts/live* and docs/testing/live-validation.md; add it as a new opt-in seed or fixture option so existing sessions are unaffected, with a short note in docs/testing/live-validation.md. Then run a session (ids `live-msg-answer2-`) at the final clean head: `msg send --answer` via CLI and via HTTP to the waiting session, each in a fresh waiting state; verify the answer is typed once into the session, the question is answered, nothing stays pending, and the reply reports live delivery; plus a refused/retry case if the fixture can produce one, a stale answer, and a non-answer msg.send that stays native (serve log marker). Keep the fixture strictly sandboxed (disposable HOME/PACER_HOME, its own socket under PACER_HOME).

## 3. Ledger wording (non-blocking)
In docs/testing/m2-ledger.md's msg.send row, state that valid answer requests with reply_to and duplicate redeliveries of stored answers forward to Core, so the native answer code is reached only by the remaining cases (name them). Do not touch the "fifty-eight selective" total line (pre-existing, recounted by the pending integration PR).

## Checks
Serial, under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny, CARGO_INCREMENTAL=0, CARGO_BUILD_JOBS=4, TZ=Asia/Ho_Chi_Minh, disposable HOME/PACER_HOME: cargo fmt --all --check; cargo clippy -p pacer-messaging-ops -p pacer-server --all-targets -- -D warnings; cargo test -p pacer-messaging-ops; cargo xtask loc --check; cargo xtask deps; bun run typecheck; cargo build -p pacer --features test-ops; the parity file, test/native-msg-writes-parity.test.ts, other test/native-msg* files, test/messaging-live.test.ts, and any live-harness tests (test/live*.test.ts) your fixture touches.

Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports. Memory is tight: no full suites, one live session at a time. Stop everything you start.

Append a "Review fixes (v2)" section to .work/reviews/fix-native-msg-live-answer-handoff.md: new head, commits, failing-then-passing evidence, fixture design, commands with counts, live session ids and Summary lines, UNVERIFIED with reasons, cleanup. Report with orca orchestration worker_done. Always end with worker_done.


Carry out the task described above.
