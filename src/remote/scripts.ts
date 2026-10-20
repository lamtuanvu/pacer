/** Fixed remote programs; user text is carried only over stdin. */
export const SCRIPTS = {
  CODEX_USAGE: `home="\${1:-$HOME/.codex}"
case "$home" in '~/'*) home="$HOME/\${home#??}" ;; esac
[ -d "$home/sessions" ] || exit 0
while IFS= read -r -d '' file; do
  mtime=$(stat -c %Y "$file" 2>/dev/null) || mtime=$(stat -f %m "$file") || continue
  printf '%s %s\\n' "$mtime" "$file"
done < <(find "$home/sessions" -type f -name 'rollout-*.jsonl' -print0) |
sort -rn | head -n 15 | while read -r mtime file; do
  tail -c 4000000 "$file" | grep '"rate_limits"' || true
done`,
  PROBE: `printf 'glibc=%s\\n' "$(getconf GNU_LIBC_VERSION 2>/dev/null | sed 's/^glibc //')"
printf 'os=%s\\n' "$(uname -s)"
printf 'arch=%s\\n' "$(uname -m)"
printf 'git=%s\\n' "$(git --version)"
printf 'codex=%s\\n' "$(command -v codex || true)"
printf 'claude=%s\\n' "$(command -v claude || true)"
printf 'setsid=%s\\n' "$(command -v setsid || true)"
printf 'script=%s\\n' "$(script --version 2>/dev/null || true)"
printf 'tail=%s\\n' "$(command -v tail)"
printf 'home=%s\\n' "$HOME"`,
  CHECK_REPO: `path="$1"; shift
case "$path" in '~/'*) path="$HOME/\${path#??}" ;; esac
case "$1" in
  home) test -d "$path" ;;
  clone) git clone -- "$2" "$path" ;;
  *)
    if [ ! -d "$path" ]; then printf 'exists=0\\n'; exit 0; fi
    printf 'exists=1\\n'
    git -C "$path" rev-parse --show-toplevel >/dev/null 2>&1 || exit 0
    printf 'git=1\\n'
    printf 'origin=%s\\n' "$(git -C "$path" remote get-url origin 2>/dev/null)"
    printf 'name=%s\\n' "$(git -C "$path" config --local user.name)"
    printf 'email=%s\\n' "$(git -C "$path" config --local user.email)"
    ;;
esac`,
  SET_IDENTITY: `path="$1"
case "$path" in '~/'*) path="$HOME/\${path#??}" ;; esac
git -C "$path" config --local user.name "$2" && git -C "$path" config --local user.email "$3"`,
  // Used only by tests and host check to verify the stdin channel.
  ECHO_STDIN: "cat",
  PREPARE: `checkout="$1"; tag="$2"; task="$3"; base="$4"; branch="$5"; attempt="\${6:-1}"
case "$checkout" in '~/'*) checkout="$HOME/\${checkout#??}" ;; esac
cd "$checkout" || exit 1
git fetch -q origin "$branch" 2>/dev/null || true
if ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  mkdir -p "$HOME/.pacer-remote" || exit 1
  tmp=$(mktemp "$HOME/.pacer-remote/base.XXXXXX") || exit 1
  trap 'rm -f "$tmp"' EXIT HUP INT TERM
  cat > "$tmp"
  if [ -s "$tmp" ]; then
    git bundle verify "$tmp" >&2 && git fetch -q "$tmp" "refs/pacer/base/$task" || exit 1
  fi
  rm -f "$tmp"
fi
git cat-file -e "$base^{commit}" 2>/dev/null || { echo missing-base >&2; exit 3; }
worktree="$HOME/.pacer-remote/worktrees/$tag/$task-$attempt"
mkdir -p "$HOME/.pacer-remote/worktrees/$tag" || exit 1
remote_branch="pacer/$task"
if git show-ref --verify --quiet "refs/heads/$remote_branch"; then
  count=$(git rev-list --count "$base..$remote_branch") || exit 1
  if [ "$count" = 0 ]; then
    # An earlier attempt may still have this unchanged branch checked out.
    git worktree add -q --force "$worktree" "$remote_branch" || exit 1
  else
    remote_branch="pacer/$task-$attempt"
    git worktree add -q -b "$remote_branch" "$worktree" "$base" || exit 1
  fi
else
  git worktree add -q -b "$remote_branch" "$worktree" "$base" || exit 1
fi
printf 'worktree=%s\\nbranch=%s\\n' "$worktree" "$remote_branch"`,
  QUESTION: `file="$1/.pacer-question"
[ -f "$file" ] || exit 0
[ "$(wc -c < "$file")" -le 4000 ] || { echo "question exceeds 1000 characters" >&2; exit 1; }
cat "$file"`,
  QUESTION_CLEAR: `rm -f -- "$1/.pacer-question"`,
  PREFLIGHT: `cd "$1" || exit 1
base="$2"; branch="$3"
case "$branch" in pacer/*) ;; *) branch="pacer/$branch" ;; esac
ancestor=0
git merge-base --is-ancestor "$base" "$branch" && ancestor=1
printf 'ancestor=%s\\n' "$ancestor"
status=$(git -c core.quotePath=true status --porcelain --untracked-files=all) || exit 1
printf 'dirty=%s\\n' "$(printf '%s\\n' "$status" | sed '/^$/d' | wc -l | tr -d ' ')"
printf 'dirty_files=%s\\n' "$(printf '%s\\n' "$status" | sed '/^$/d;s/^...//' | head -n 20 | paste -sd ',' -)"
printf 'commits=%s\\n' "$(git rev-list --count "$base..$branch")"
printf 'emails=%s\\n' "$(git log --format='%ae%n%ce' "$base..$branch" | sed '/^$/d' | LC_ALL=C sort -u | paste -sd ',' -)"
printf 'signoffs=%s\\n' "$(git log --format='%B' "$base..$branch" | sed -n 's/^[Ss][Ii][Gg][Nn][Ee][Dd]-[Oo][Ff][Ff]-[Bb][Yy]:.*<\\([^>]*\\)>.*/\\1/p' | LC_ALL=C sort -u | paste -sd ',' -)"
printf 'head=%s\\n' "$(git rev-parse "$branch^{commit}")"`,
  BUNDLE_OUT: `cd "$1" || exit 1
branch="$3"
case "$branch" in pacer/*) ;; *) branch="pacer/$branch" ;; esac
git bundle create - "$2..$branch"`,
  CLEAN: `worktree="$1"; D="$2"; checkout="$3"; task="$4"; delete_branch="$5"
case "$worktree" in '~/'*) worktree="$HOME/\${worktree#??}" ;; esac
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
case "$checkout" in '~/'*) checkout="$HOME/\${checkout#??}" ;; esac
# Resolve the task run directory before deleting anything; reject traversal and symlink escapes.
remote_home=$(cd "$HOME" && pwd -P) || exit 1
runs=$(cd "$HOME/.pacer-remote/runs" && pwd -P) || exit 1
D=$(cd "$(dirname "$D")" && pwd -P) || exit 1
case "$D" in "$remote_home/.pacer-remote/runs/"*) ;; *) exit 1 ;; esac
[ "$(basename "$D")" = "$task" ] && [ "$D" = "$runs/$task" ] || exit 1
cd "$checkout" || exit 1
if [ -d "$worktree" ]; then git worktree remove --force "$worktree" || exit 1; fi
rm -rf "$D" || exit 1
if [ -n "$delete_branch" ] && git show-ref --verify --quiet "refs/heads/$delete_branch"; then
  git branch -D "$delete_branch" || exit 1
fi`,
  BINARY: `hash="$1"; action="$2"
[[ "$hash" =~ ^[a-f0-9]{64}$ ]] || exit 1
umask 077
dir="$HOME/.pacer-remote/bin/$hash"
file="$dir/pacer"
checksum() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi; }
if [ "$action" = check ]; then
  [ -x "$file" ] && [ "$(checksum "$file" | cut -d ' ' -f 1)" = "$hash" ] || exit 1
else
  mkdir -p "$dir" || exit 1
  chmod 700 "$HOME/.pacer-remote" "$HOME/.pacer-remote/bin" "$dir" || exit 1
  tmp=$(mktemp "$dir/upload.XXXXXX") || exit 1
  trap 'rm -f "$tmp"' EXIT
  # Decode portably on GNU and BSD hosts.
  if base64 --help 2>&1 | grep -q -- --decode; then base64 --decode > "$tmp"; else base64 -D > "$tmp"; fi
  [ "$(checksum "$tmp" | cut -d ' ' -f 1)" = "$hash" ] || { echo 'remote binary hash mismatch' >&2; exit 1; }
  chmod 700 "$tmp" && mv -f "$tmp" "$file" || exit 1
fi
printf '%s\\n' "$file"`,
  SESSION_FILES: `D="$1"; offset="$2"; previous_inode="$3"; previous_ckpt="$4"; previous_rotated="$5"
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
# Retry if a checkpoint/rotation changes while copying the retained generation.
for attempt in 1 2 3; do
  before=$(cksum "$D/session.ckpt" "$D/session.log.1" 2>/dev/null)
  inode=$(ls -i "$D/session.log" 2>/dev/null | awk '{print $1}')
  bytes=0; [ ! -f "$D/session.log" ] || bytes=$(wc -c < "$D/session.log")
  start="$offset"
  [ "$inode" = "$previous_inode" ] && [ "$bytes" -ge "$start" ] || start=0
  data="session.log.inode=$inode
session.log.offset=$start
"
  for file in session.ckpt session.log.1 session.log session.state; do
    case "$file" in session.ckpt|session.log.1) sum=$(cksum "$D/$file" 2>/dev/null) ;; *) sum=""; [ ! -f "$D/$file" ] || sum=present ;; esac
    data="$data$file.sum=$sum
"
    case "$file" in
      session.ckpt) [ "$sum" != "$previous_ckpt" ] || continue ;;
      session.log.1) [ "$sum" != "$previous_rotated" ] || continue ;;
    esac
    hex=""
    if [ -f "$D/$file" ]; then
      if [ "$file" = session.log ]; then
        hex=$(tail -c +"$((start + 1))" "$D/$file" | od -An -v -tx1 | tr -d ' \n')
      else hex=$(od -An -v -tx1 "$D/$file" | tr -d ' \n'); fi
    fi
    data="$data$file=$hex
"
  done
  after=$(cksum "$D/session.ckpt" "$D/session.log.1" 2>/dev/null)
  [ "$before" = "$after" ] && [ "$inode" = "$(ls -i "$D/session.log" 2>/dev/null | awk '{print $1}')" ] && { printf '%s' "$data"; exit 0; }
done
exit 1`,
  SESSION_PIPE: `# socket exec pipe: use the uploaded runtime, without extra host dependencies.
D="$1"
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
binary=$(cat "$D/session.binary") || exit 1
if [ -f "$D/session.sock.path" ]; then path=$(cat "$D/session.sock.path"); else path="$D/session.sock"; fi
exec "$binary" _session "socket:$path"`,
  SESSION_SOCKET: `D="$1"
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
if [ -f "$D/session.sock.path" ]; then path=$(cat "$D/session.sock.path"); else path="$D/session.sock"; fi
[ -S "$path" ] || exit 1
printf '%s' "$path"`,
  START: `D="$1"; cwd="$2"; mode="$3"; shift 3
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
case "$cwd" in '~/'*) cwd="$HOME/\${cwd#??}" ;; esac
umask 077
mkdir -p "$D" || exit 1
chmod 700 "$D"
printf '%s' "$mode" > "$D/session.host"
rm -f "$D/start.error" "$D/pid" "$D/pid.tmp" "$D/child" "$D/started" "$D/exit" "$D/exit.tmp" "$D/stdout" "$D/stderr" "$D/session.raw" "$D/session.log" "$D/session.log.1" "$D/session.ckpt" "$D/session.state" "$D/session.sock.path"
# Read only the wrapper as lines; cat preserves every byte of the remaining prompt.
: > "$D/run.sh"
while IFS= read -r line; do
  [ "$line" = '__PACER_STDIN__' ] && break
  printf '%s\\n' "$line" >> "$D/run.sh"
done
cat > "$D/stdin"
chmod 700 "$D/run.sh"
chmod 600 "$D/stdin"
if [ "$mode" = full ]; then mv "$D/run.sh" "$D/session.json" || exit 1; fi
cd "$cwd" || exit 1
setsid nohup env -i HOME="$HOME" PATH="$PATH" bash -c '
D="$1"; mode="$2"; shift 2
if [ "$mode" = full ]; then binary="$1"; shift; fi
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  pair="$1"; key=\${pair%%=*}; value=\${pair#*=}
  case "$value" in "~/"*) value="$HOME/\${value#??}" ;; esac
  export "$key=$value"
  shift
done
shift
if [ "$mode" = full ]; then
  hash=\${binary%/pacer}; hash=\${hash##*/}
  # A refusal is written down so START reports it at once instead of waiting for a pid.
  [[ "$hash" =~ ^[a-f0-9]{64}$ ]] || { printf "invalid runtime path" > "$D/start.error"; exit 1; }
  if command -v sha256sum >/dev/null; then actual=$(sha256sum "$binary"); else actual=$(shasum -a 256 "$binary"); fi
  [ "\${actual%% *}" = "$hash" ] || { printf "runtime binary failed its hash check" > "$D/start.error"; exit 1; }
  printf "%s" "$binary" > "$D/session.binary"
  exec "$binary" _session "$D"
fi
if [ "$mode" = pty ]; then
  command=""
  for arg in "$@"; do printf -v quoted "%q" "$arg"; command="$command $quoted"; done
  printf -v input "%q" "$D/stdin"
  command="$command < $input"
  export TERM=xterm-256color SHELL="$BASH"
  exec sh "$D/run.sh" "$D" script -qfec "$command" "$D/session.raw"
fi
exec sh "$D/run.sh" "$D" "$@"
' pacer "$D" "$mode" "$@" </dev/null >/dev/null 2>&1 &
n=0
while [ ! -s "$D/pid" ] && [ ! -s "$D/start.error" ] && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
if [ -s "$D/start.error" ]; then printf 'error=%s\\n' "$(cat "$D/start.error")"; exit 0; fi
[ -s "$D/pid" ] || exit 1
printf 'pid=%s\\n' "$(cat "$D/pid")"`,
  REPORT: `D="$1"
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
printf 'session=%s\\n' "$(cat "$D/session.host" 2>/dev/null)"
pid=$(cat "$D/pid" 2>/dev/null); alive=0
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  case "$(ps -o args= -p "$pid")" in *"$D/run.sh"*|*"_session $D") alive=1 ;; esac
fi
printf 'pid=%s\\nalive=%s\\nexit=%s\\nstarted=%s\\n' "$pid" "$alive" "$(cat "$D/exit" 2>/dev/null)" "$(cat "$D/started" 2>/dev/null)"
for stream in stdout stderr session.raw; do
  bytes=0; stamp=''
  if [ -f "$D/$stream" ]; then
    bytes=$(wc -c < "$D/$stream" | tr -d ' ')
    stamp=$(stat -c %Y "$D/$stream" 2>/dev/null) || stamp=$(stat -f %m "$D/$stream" 2>/dev/null)
  fi
  case "$stream" in stdout) key=out ;; stderr) key=err ;; session.raw) key=raw ;; esac
  printf '%s=%s\\n%sm=%s\\n' "$key" "$bytes" "$key" "$stamp"
done`,
  READ_FROM: `D="$1"
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
[ -f "$D/$2" ] || exit 0
# Hex mode preserves arbitrary bytes across the text-only RunFn boundary.
if [ "\${5:-}" = "hex" ]; then
  tail -c +"$(($3 + 1))" "$D/$2" | head -c "$4" | od -An -v -tx1 | tr -d ' \n'
else
  tail -c +"$(($3 + 1))" "$D/$2" | head -c "$4"
fi`,
  FOLLOW: `D="$1"
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
p="$(cat "$D/pid" 2>/dev/null)"; me=$$
# Portable stand-in for tail --pid: a watcher with no inherited output ends the tail after the run exits.
[ -n "$p" ] && ( while kill -0 "$p" 2>/dev/null; do sleep 1; done; sleep 1; kill "$me" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
exec tail -c +"$(($2 + 1))" -f "$D/session.raw"`,
  STOP: `D="$1"; grace="$2"
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
if [ -f "$D/exit" ]; then printf 'code=%s\\nkilled=0\\n' "$(cat "$D/exit")"; exit 0; fi
pid=$(cat "$D/pid" 2>/dev/null)
case "$pid" in ''|*[!0-9]*) printf 'code=137\\nkilled=0\\n'; exit 0 ;; esac
case "$(ps -o args= -p "$pid")" in *"$D/run.sh"*|*"_session $D") ;; *) printf 'code=137\\nkilled=0\\n'; exit 0 ;; esac
end=$(($(date +%s) + grace))
while [ ! -f "$D/child" ] && [ "$(date +%s)" -lt "$end" ]; do sleep 0.05; done
kill -TERM -- "-$pid" 2>/dev/null
while [ "$(date +%s)" -lt "$end" ]; do
  if [ -f "$D/exit" ]; then printf 'code=%s\\nkilled=0\\n' "$(cat "$D/exit")"; exit 0; fi
  sleep 0.05
done
kill -KILL -- "-$pid" 2>/dev/null
sleep 0.1
if [ -f "$D/exit" ]; then printf 'code=%s\\nkilled=0\\n' "$(cat "$D/exit")"; else
  printf '137\\n' > "$D/exit"
  printf 'code=137\\nkilled=1\\n'
fi`,
} as const;
