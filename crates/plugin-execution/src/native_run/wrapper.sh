#!/bin/sh
# pacer attempt wrapper v1
D="$1"; shift
# Bookkeeping files are private; the agent keeps the umask the wrapper was started with.
pacer_umask=$(umask)
umask 077
pacer_admission="${PACER_COMPLETION_NONCE:-$PACER_ADMISSION_SESSION}"
unset PACER_ADMISSION_SESSION PACER_ADMISSION_DIR PACER_COMPLETION_NONCE
echo $$ > "$D/pid.tmp" && /bin/mv "$D/pid.tmp" "$D/pid"
/bin/date +%s > "$D/started"
child=""
finish() {
  echo "$1" > "$D/exit.tmp" && /bin/mv "$D/exit.tmp" "$D/exit"
  if [ -n "$pacer_admission" ]; then
    printf '%s\n' "$pacer_admission" > "$D/admission.complete.$pacer_admission.tmp" && /bin/mv "$D/admission.complete.$pacer_admission.tmp" "$D/admission.complete"
  fi
  exit "$1"
}
on_term() { if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; fi; finish 143; }
trap on_term TERM INT HUP
if [ -f "$D/stdin" ]; then (umask "$pacer_umask"; exec "$@") < "$D/stdin" > "$D/stdout" 2> "$D/stderr" & else (umask "$pacer_umask"; exec "$@") < /dev/null > "$D/stdout" 2> "$D/stderr" & fi
child=$!
echo "$child" > "$D/child"
wait "$child"
finish $?
