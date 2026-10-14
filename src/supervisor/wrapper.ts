export const WRAPPER_VERSION = 1;

/**
 * pacer attempt wrapper. Usage: sh run.sh <attempt-dir> <argv...>
 * Records pid, started, stdout, stderr and exit in the attempt directory; those files are the run's record.
 * POSIX sh only: the same script runs on remote hosts over SSH (phase 5).
 * Its own bookkeeping uses /bin/mv and /bin/date, never the agent's PATH, which may be minimal or unrelated.
 */
export const WRAPPER_SH = `#!/bin/sh
# pacer attempt wrapper v${WRAPPER_VERSION}
D="$1"; shift
echo $$ > "$D/pid.tmp" && /bin/mv "$D/pid.tmp" "$D/pid"
/bin/date +%s > "$D/started"
child=""
finish() { echo "$1" > "$D/exit.tmp" && /bin/mv "$D/exit.tmp" "$D/exit"; exit "$1"; }
on_term() { if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; fi; finish 143; }
trap on_term TERM INT HUP
if [ -f "$D/stdin" ]; then "$@" < "$D/stdin" > "$D/stdout" 2> "$D/stderr" & else "$@" < /dev/null > "$D/stdout" 2> "$D/stderr" & fi
child=$!
echo "$child" > "$D/child"
wait "$child"
finish $?
`;
