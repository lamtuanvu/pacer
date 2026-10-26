# SSH remote START authority

## Context

After PREPARE and binary verification, the host's remote attempt starts one persisted run through the fixed `START` script. The current host calls OpenSSH directly. The script receives a JSON session launch or wrapper, a delimiter, and the executor prompt over stdin. The existing `hostRunner.run` RPC cannot carry that stdin safely: its public text field is limited to 64 KiB and the provider currently refuses it.

## Decision

Keep `START` as a fixed bundled SSH script and route its one launch through a host-issued, one-use grant for the exact persisted task/run, configured host, worktree, mode, runtime path, executor argv, environment and input hash/length. The host captures the complete stdin bytes before opening the provider session. A private `start-input` process capability streams at most 50 MiB from host memory into the pinned OpenSSH child with pipe backpressure; the prompt does not enter plugin JSON or logs. The provider receives the existing `hostRunner.run` request shape with `script: START`, exact arguments and a host-issued completion nonce, but no public `stdin` field. The broker pins the exact resulting `ssh` argv and the private bytes to one invocation.

The host checks the persisted run and provider/control-directory generation before opening, just before issue, periodically during the call, and after a response. A changed task run/host or disabled provider cancels the call. The provider accepts only the issued fixed `START` argv and refuses arbitrary shell, paths, modes, or excess arguments. The remote script's existing `__PACER_BEGIN__` payload framing remains. A nonce receipt after the result is required to settle the operation lease. A timeout, missing/malformed receipt, provider refusal, or lost response leaves the launch uncertain and does not retry through direct SSH. The existing session admission lease remains unsettled whenever START might have reached the host.

No public host-caller operation is added. The only protocol change is enabling the already-declared `START` script ID on `hostRunner.run`; stdin bytes stay in the host-owned process capability. The 50 MiB cap and maximum argument frame size are explicit compatibility bounds; oversize requests fail before issue, without fallback.

## Validation

Focused tests cover exact stdin bytes including hostile shell text, a one-use persisted-run grant, source/host drift, provider disablement, oversize input, no direct fallback, lost receipt and timeout uncertainty, and normal pipe/full-session starts. CT-11 runs a harmless task on the approved disposable SSH checkout through the guarded harness. Streaming FOLLOW and bidirectional SESSION_PIPE retain their direct paths for separate authority designs.
