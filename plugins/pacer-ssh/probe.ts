/** This fixed program mirrors SCRIPTS.PROBE; parity is checked in tests. */
export const PROBE_SCRIPT = `printf 'glibc=%s\\n' "$(getconf GNU_LIBC_VERSION 2>/dev/null | sed 's/^glibc //')"
printf 'os=%s\\n' "$(uname -s)"
printf 'arch=%s\\n' "$(uname -m)"
printf 'git=%s\\n' "$(git --version)"
printf 'codex=%s\\n' "$(command -v codex || true)"
printf 'claude=%s\\n' "$(command -v claude || true)"
printf 'setsid=%s\\n' "$(command -v setsid || true)"
printf 'script=%s\\n' "$(script --version 2>/dev/null || true)"
printf 'tail=%s\\n' "$(command -v tail)"
printf 'home=%s\\n' "$HOME"`;

/** Fixed host CHECK_REPO program. The provider admits only its read-only check arm. */
export const CHECK_REPO_SCRIPT = `path="$1"; shift
case "$path" in '~/'*) path="$HOME/\${path#??}" ;; esac
case "$1" in
  home) test -d "$path" ;;
  clone) [ ! -e "$path" ] && [ ! -L "$path" ] || exit 1; git clone -- "$2" "$path" ;;
  *)
    if [ ! -d "$path" ]; then printf 'exists=0\\n'; exit 0; fi
    printf 'exists=1\\n'
    git -C "$path" rev-parse --show-toplevel >/dev/null 2>&1 || exit 0
    printf 'git=1\\n'
    printf 'origin=%s\\n' "$(git -C "$path" remote get-url origin 2>/dev/null)"
    printf 'name=%s\\n' "$(git -C "$path" config --local user.name)"
    printf 'email=%s\\n' "$(git -C "$path" config --local user.email)"
    ;;
esac`;

/** Fixed read-only bundle program; parity with SCRIPTS.BUNDLE_OUT is tested. */
export const BUNDLE_OUT_SCRIPT = `cd "$1" || exit 1
branch="$3"
case "$branch" in pacer/*) ;; *) branch="pacer/$branch" ;; esac
git bundle create - "$2..$branch"`;

/** Fixed read-only remote head/cleanliness program; parity with SCRIPTS.PREFLIGHT is tested. */
export const PREFLIGHT_SCRIPT = `cd "$1" || exit 1
base="$2"; branch="$3"
case "$branch" in pacer/*) ;; *) branch="pacer/$branch" ;; esac
ancestor=0
git merge-base --is-ancestor "$base" "$branch" && ancestor=1
printf 'ancestor=%s\\n' "$ancestor"
status=$(git -c core.quotePath=true status --porcelain --untracked-files=all) || exit 1
if [ -n "$4" ] && [ -n "$5" ] && [ -f .pacer-question ]; then
  question_hash=$(git hash-object -- .pacer-question) || exit 1
  case "\${#question_hash}" in 40) expected_hash="$4" ;; 64) expected_hash="$5" ;; *) expected_hash="" ;; esac
  if [ -n "$expected_hash" ] && [ "$question_hash" = "$expected_hash" ] &&
    [ "$(git hash-object -- .pacer-question)" = "$expected_hash" ]; then
    status=$(printf '%s\\n' "$status" | sed '/^?? \\.pacer-question$/d')
  fi
fi
printf 'dirty=%s\\n' "$(printf '%s\\n' "$status" | sed '/^$/d' | wc -l | tr -d ' ')"
printf 'dirty_files=%s\\n' "$(printf '%s\\n' "$status" | sed '/^$/d;s/^...//' | head -n 20 | paste -sd ',' -)"
printf 'commits=%s\\n' "$(git rev-list --count "$base..$branch")"
printf 'emails=%s\\n' "$(git log --format='%ae%n%ce' "$base..$branch" | sed '/^$/d' | LC_ALL=C sort -u | paste -sd ',' -)"
printf 'signoffs=%s\\n' "$(git log --format='%B' "$base..$branch" | sed -n 's/^[Ss][Ii][Gg][Nn][Ee][Dd]-[Oo][Ff][Ff]-[Bb][Yy]:.*<\\([^>]*\\)>.*/\\1/p' | LC_ALL=C sort -u | paste -sd ',' -)"
printf 'head=%s\\n' "$(git rev-parse "$branch^{commit}")"`;

/** Fixed configured-checkout identity operation; the host pins the complete argv. */
export const SET_IDENTITY_SCRIPT = `path="$1"
case "$path" in '~/'*) path="$HOME/\${path#??}" ;; esac
git -C "$path" config --local user.name "$2" && git -C "$path" config --local user.email "$3"`;

/** Fixed cleanup script; parity with SCRIPTS.CLEAN is checked in tests. */
export const CLEAN_SCRIPT = `worktree="$1"; D="$2"; checkout="$3"; task="$4"; delete_branch="$5"
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
if [ -d "$worktree" ]; then
  if [ "\${6:-}" = force ]; then
    git worktree remove --force "$worktree" || exit 1
  else
    dirty=$(git -C "$worktree" status --porcelain) || exit 1
    [ -z "$dirty" ] || { printf 'uncommitted changes; keeping remote worktree\\n' >&2; exit 1; }
    git worktree remove "$worktree" || exit 1
  fi
fi
rm -rf "$D" || exit 1
if [ -n "$delete_branch" ] && git show-ref --verify --quiet "refs/heads/$delete_branch"; then
  git branch -D "$delete_branch" || exit 1
fi`;

/** Fixed remote stop script; parity with SCRIPTS.STOP is checked in tests. */
export const STOP_SCRIPT = `D="$1"; grace="$2"
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
fi`;

/** Fixed remote preparation script; the host owns the exact tuple and stdin bytes. */
export const PREPARE_SCRIPT = `checkout="$1"; tag="$2"; task="$3"; base="$4"; branch="$5"; attempt="\${6:-1}"
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
printf 'worktree=%s\\nbranch=%s\\n' "$worktree" "$remote_branch"`;

/** Fixed persisted-run observation program; parity with SCRIPTS.REPORT is tested. */
export const REPORT_SCRIPT = `D="$1"
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
printf 'admission_complete=%s\\n' "$(cat "$D/admission.complete" 2>/dev/null)"
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
done`;

/** Fixed bounded full-session metadata program; parity with SCRIPTS.SESSION_FILES is tested. */
export const SESSION_FILES_SCRIPT = `D="$1"
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
# Return only bounded metadata. File bytes are read separately in fixed ranges.
for attempt in 1 2 3; do
  before=$(cksum "$D/session.ckpt" "$D/session.log.1" 2>/dev/null)
  inode=$(ls -i "$D/session.log" 2>/dev/null | awk '{print $1}')
  data=""
  for file in session.ckpt session.log.1 session.log session.state; do
    bytes=""; sum=""
    if [ -f "$D/$file" ]; then
      if [ "$file" = session.state ]; then
        sum=$(cksum "$D/$file" 2>/dev/null) || sum=""
        bytes=""; [ -z "$sum" ] || bytes=$(printf '%s\n' "$sum" | awk '{print $2}')
      else bytes=$(wc -c < "$D/$file" | tr -d ' ') || exit 1; fi
      if [ "$file" = session.log ]; then
        sum="$inode"
      elif [ "$file" != session.state ]; then
        sum=$(cksum "$D/$file") || exit 1
      fi
    fi
    data="$data$file.bytes=$bytes
$file.sum=$sum
"
  done
  after=$(cksum "$D/session.ckpt" "$D/session.log.1" 2>/dev/null)
  [ "$before" = "$after" ] && [ "$inode" = "$(ls -i "$D/session.log" 2>/dev/null | awk '{print $1}')" ] && { printf '%s' "$data"; exit 0; }
done
exit 1`;

/** Fixed remote launch program; parity with SCRIPTS.START is tested. */
export const START_SCRIPT = `D="$1"; cwd="$2"; mode="$3"; shift 3
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
case "$cwd" in '~/'*) cwd="$HOME/\${cwd#??}" ;; esac
umask 077
mkdir -p "$D" || exit 1
chmod 700 "$D"
printf '%s' "$mode" > "$D/session.host"
rm -f "$D/start.error" "$D/pid" "$D/pid.tmp" "$D/child" "$D/started" "$D/exit" "$D/exit.tmp" "$D/stdout" "$D/stderr" "$D/session.raw" "$D/session.log" "$D/session.log.1" "$D/session.ckpt" "$D/session.state" "$D/session.sock.path" "$D/session.version"
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
printf 'pid=%s\\n' "$(cat "$D/pid")"`;

/** Fixed bounded run-output reader; parity with SCRIPTS.READ_FROM is tested. */
export const READ_FROM_SCRIPT = `D="$1"
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
[ -f "$D/$2" ] || exit 0
# Hex mode preserves arbitrary bytes across the text-only RunFn boundary.
if [ "\${5:-}" = "hex" ]; then
  tail -c +"$(($3 + 1))" "$D/$2" | head -c "$4" | od -An -v -tx1 | tr -d ' \n'
else
  tail -c +"$(($3 + 1))" "$D/$2" | head -c "$4"
fi`;

/** Fixed content-addressed runtime check; parity with SCRIPTS.BINARY is tested. */
export const BINARY_SCRIPT = `hash="$1"; action="$2"
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
printf '%s\\n' "$file"`;

/** Fixed persisted-run socket discovery; parity with SCRIPTS.SESSION_SOCKET is tested. */
export const SESSION_SOCKET_SCRIPT = `D="$1"
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
if [ -f "$D/session.sock.path" ]; then path=$(cat "$D/session.sock.path"); else path="$D/session.sock"; fi
[ -S "$path" ] || exit 1
printf '%s' "$path"`;

/** Fixed full-session socket bridge; parity with SCRIPTS.SESSION_PIPE is checked. */
export const SESSION_PIPE_SCRIPT = `# socket exec pipe: use the uploaded runtime, without extra host dependencies.
D="$1"
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
binary=$(cat "$D/session.binary") || exit 1
if [ -f "$D/session.sock.path" ]; then path=$(cat "$D/session.sock.path"); else path="$D/session.sock"; fi
exec "$binary" _session "socket:$path"`;

export const QUESTION_SCRIPT = `file="$1/.pacer-question"
[ -f "$file" ] || exit 0
[ "$(wc -c < "$file")" -le 4000 ] || { echo "question exceeds 1000 characters" >&2; exit 1; }
cat "$file"`;

/** Fixed read-only Codex session-log probe; parity with the legacy script is tested. */
export const CODEX_USAGE_SCRIPT = `home="\${1:-$HOME/.codex}"
case "$home" in '~/'*) home="$HOME/\${home#??}" ;; esac
[ -d "$home/sessions" ] || exit 0
while IFS= read -r -d '' file; do
  mtime=$(stat -c %Y "$file" 2>/dev/null) || mtime=$(stat -f %m "$file") || continue
  printf '%s %s\\n' "$mtime" "$file"
done < <(find "$home/sessions" -type f -name 'rollout-*.jsonl' -print0) |
sort -rn | head -n 15 | while read -r mtime file; do
  tail -c 4000000 "$file" | while IFS= read -r line; do
    case "$line" in *\'"rate_limits"\'*) printf '%s\\n' "$line";; esac
  done || true
done`;

const shq = (value: string) => /^[A-Za-z0-9_\\/.:=@%+-]+$/.test(value)
  ? value : `'${value.replace(/'/g, "'\\''")}'`;

/** Exact argv issued separately by the host's process capability. */
function issuedArgv(sshTarget: string, controlPath: string, script: string, args: string[], completionNonce?: string): string[] {
  if (!/^[A-Za-z0-9._@][A-Za-z0-9._@-]*$/.test(sshTarget) ||
    !controlPath.startsWith("/") || controlPath.includes("\0") || !controlPath.endsWith("/cm-%C"))
    throw Error("invalid host-issued SSH snapshot");
  const program = completionNonce
    ? `printf '__PACER_BEGIN__\\n'; ( ${script}\n); pacer_result=$?; printf '\\n__PACER_DONE__=${completionNonce}\\n'; exit "$pacer_result"`
    : `printf '__PACER_BEGIN__\\n'; ${script}`;
  return [
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
    "-o", "ControlMaster=auto", "-o", `ControlPath=${controlPath}`,
    "-o", "ControlPersist=60", "--", sshTarget,
    `bash -lc ${shq(program)} pacer${args.map(arg => ` ${shq(arg)}`).join("")}`,
  ];
}

export function probeArgv(sshTarget: string, controlPath: string): string[] {
  return issuedArgv(sshTarget, controlPath, PROBE_SCRIPT, []);
}

export function checkRepoArgv(sshTarget: string, controlPath: string, repo: string): string[] {
  if (!repo || repo.includes("\0")) throw Error("invalid host-issued repo path");
  return issuedArgv(sshTarget, controlPath, CHECK_REPO_SCRIPT, [repo, "check"]);
}

export function checkHomeArgv(sshTarget: string, controlPath: string, home: string): string[] {
  if (!home || home.includes("\0")) throw Error("invalid host-issued account home");
  return issuedArgv(sshTarget, controlPath, CHECK_REPO_SCRIPT, [home, "home"]);
}

export function cloneRepoArgv(sshTarget: string, controlPath: string, args: readonly string[], completionNonce: string): string[] {
  if (args.length !== 3 || typeof args[0] !== "string" ||
    !(args[0].startsWith("/") || args[0].startsWith("~/")) || args[0].length > 4096 ||
    args[1] !== "clone" || typeof args[2] !== "string" || !args[2] || args[2].length > 4096 ||
    args.some(value => /[\u0000-\u001f\u007f]/.test(value)) ||
    !/^[a-f0-9-]{36}$/.test(completionNonce))
    throw Error("invalid host-issued clone tuple");
  return issuedArgv(sshTarget, controlPath, CHECK_REPO_SCRIPT, [...args], completionNonce);
}

export function cleanArgv(sshTarget: string, controlPath: string, args: readonly string[], completionNonce: string): string[] {
  if (![5, 6].includes(args.length) || (args.length === 6 && args[5] !== "" && args[5] !== "force") ||
    args.some(value => typeof value !== "string" || value.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(value)) ||
    !args.slice(0, 2).every(value => value.startsWith("/")) ||
    !(args[2]!.startsWith("/") || args[2]!.startsWith("~/")) ||
    !/^t-\d{8}-\d{6}-[0-9a-f]{4}$/.test(args[3]!) ||
    (args[4] !== "" && args[4] !== `pacer/${args[3]}` &&
      !new RegExp(`^pacer/${args[3]}-[1-9][0-9]*$`).test(args[4]!)) ||
    !/^[a-f0-9-]{36}$/.test(completionNonce))
    throw Error("invalid host-issued clean tuple");
  return issuedArgv(sshTarget, controlPath, CLEAN_SCRIPT, [...args], completionNonce);
}

export function stopArgv(sshTarget: string, controlPath: string, args: readonly string[], completionNonce: string): string[] {
  if (args.length !== 2 || typeof args[0] !== "string" || !args[0].startsWith("/") ||
    args[0].length > 4096 || /[\u0000-\u001f\u007f]/.test(args[0]) ||
    !/^(?:[1-9]|[1-5][0-9]|60)$/.test(args[1] ?? "") ||
    !/^[a-f0-9-]{36}$/.test(completionNonce)) throw Error("invalid host-issued stop tuple");
  return issuedArgv(sshTarget, controlPath, STOP_SCRIPT, [...args], completionNonce);
}

export function startArgv(sshTarget: string, controlPath: string, args: readonly string[], completionNonce: string): string[] {
  if (args.length < 6 || args.length > 25 || args.some(value => typeof value !== "string" ||
    value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) ||
    !/^\/.+\/\.pacer-remote\/runs\/t-\d{8}-\d{6}-[0-9a-f]{4}\/[1-9][0-9]*$/.test(args[0]!) ||
    !args[1]!.startsWith("/") || !["full", "pty", "pipe"].includes(args[2]!) ||
    (args[2] === "full" && !/^\/.+\/\.pacer-remote\/bin\/[a-f0-9]{64}\/pacer$/.test(args[3]!)) ||
    args.indexOf("--") < (args[2] === "full" ? 4 : 3) || args.indexOf("--") >= args.length - 1 ||
    args.slice(args[2] === "full" ? 4 : 3, args.indexOf("--")).some(value => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) ||
    !/^[a-f0-9-]{36}$/.test(completionNonce)) throw Error("invalid host-issued start tuple");
  return issuedArgv(sshTarget, controlPath, START_SCRIPT, [...args], completionNonce);
}

export function prepareArgv(sshTarget: string, controlPath: string, args: readonly string[], completionNonce: string): string[] {
  if (args.length !== 6 || args.some(value => typeof value !== "string" || value.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(value)) ||
    !(args[0]!.startsWith("/") || args[0]!.startsWith("~/")) ||
    !/^[A-Za-z0-9._-]+-[a-f0-9]{8}$/.test(args[1]!) ||
    !/^t-\d{8}-\d{6}-[0-9a-f]{4}$/.test(args[2]!) ||
    !/^[a-f0-9]{40,64}$/.test(args[3]!) || !args[4] ||
    !/^[1-9][0-9]*$/.test(args[5]!) || !/^[a-f0-9-]{36}$/.test(completionNonce))
    throw Error("invalid host-issued prepare tuple");
  return issuedArgv(sshTarget, controlPath, PREPARE_SCRIPT, [...args], completionNonce);
}

export function reportArgv(sshTarget: string, controlPath: string, args: readonly string[]): string[] {
  if (args.length !== 1 || typeof args[0] !== "string" || !args[0].startsWith("/") ||
    args[0].length > 4096 || /[\u0000-\u001f\u007f]/.test(args[0]))
    throw Error("invalid host-issued report directory");
  return issuedArgv(sshTarget, controlPath, REPORT_SCRIPT, [...args]);
}

export function sessionFilesArgv(sshTarget: string, controlPath: string, args: readonly string[]): string[] {
  if (args.length !== 1 || !/^(\/|~\/)[^\u0000-\u001f\u007f]+$/.test(args[0] ?? ""))
    throw Error("invalid host-issued session files path");
  return issuedArgv(sshTarget, controlPath, SESSION_FILES_SCRIPT, [...args]);
}

export function readFromArgv(sshTarget: string, controlPath: string, args: readonly string[]): string[] {
  if (args.length !== 5 || args.some(value => typeof value !== "string") ||
    !args[0]!.startsWith("/") ||
    args[0].length > 4096 || /[\u0000-\u001f\u007f]/.test(args[0]) ||
    !["stdout", "stderr", "session.raw", "session.log", "session.log.1", "session.ckpt", "session.state", "last.md"].includes(args[1]!) ||
    !/^(?:0|[1-9][0-9]*)$/.test(args[2]!) || !Number.isSafeInteger(Number(args[2])) ||
    !/^[1-9][0-9]*$/.test(args[3]!) || Number(args[3]) > 262_144 ||
    !Number.isSafeInteger(Number(args[2]) + Number(args[3])) || args[4] !== "hex")
    throw Error("invalid host-issued output range");
  return issuedArgv(sshTarget, controlPath, READ_FROM_SCRIPT, [...args]);
}

export function sessionSocketArgv(sshTarget: string, controlPath: string, args: readonly string[]): string[] {
  if (args.length !== 1 || typeof args[0] !== "string" || !args[0].startsWith("/") ||
    args[0].length > 4096 || /[\u0000-\u001f\u007f]/.test(args[0]))
    throw Error("invalid host-issued session run directory");
  return issuedArgv(sshTarget, controlPath, SESSION_SOCKET_SCRIPT, [...args]);
}

export function sessionPipeArgv(sshTarget: string, controlPath: string, args: readonly string[]): string[] {
  if (args.length !== 1 || typeof args[0] !== "string" ||
    !/^\/.+\/\.pacer-remote\/runs\/t-\d{8}-\d{6}-[0-9a-f]{4}\/[1-9][0-9]*$/.test(args[0]) ||
    args[0].length > 4096 || /[\u0000-\u001f\u007f]/.test(args[0]))
    throw Error("invalid host-issued session pipe directory");
  return issuedArgv(sshTarget, controlPath, SESSION_PIPE_SCRIPT, [...args]);
}

export function binaryCheckArgv(sshTarget: string, controlPath: string, args: readonly string[]): string[] {
  if (args.length !== 2 || !/^[a-f0-9]{64}$/.test(args[0] ?? "") || args[1] !== "check")
    throw Error("invalid host-issued binary check");
  return issuedArgv(sshTarget, controlPath, BINARY_SCRIPT, [...args]);
}

export function binaryUploadArgv(sshTarget: string, controlPath: string, args: readonly string[], completionNonce: string): string[] {
  if (args.length !== 2 || !/^[a-f0-9]{64}$/.test(args[0] ?? "") || args[1] !== "upload" ||
    !/^[a-f0-9-]{36}$/.test(completionNonce)) throw Error("invalid host-issued binary upload");
  return issuedArgv(sshTarget, controlPath, BINARY_SCRIPT, [...args], completionNonce);
}

export function bundleOutArgv(sshTarget: string, controlPath: string, args: readonly string[]): string[] {
  if (args.length !== 3 || typeof args[0] !== "string" || !args[0].startsWith("/") ||
    args[0].length > 4096 || /[\u0000-\u001f\u007f]/.test(args[0]) ||
    typeof args[1] !== "string" || !/^[a-f0-9]{40,64}$/.test(args[1]) ||
    typeof args[2] !== "string" || !/^pacer\/[A-Za-z0-9._/-]+$/.test(args[2]) ||
    args[2].includes("..") || args[2].includes("//"))
    throw Error("invalid host-issued bundle tuple");
  return issuedArgv(sshTarget, controlPath, BUNDLE_OUT_SCRIPT, [...args]);
}

export function preflightArgv(sshTarget: string, controlPath: string, args: readonly string[]): string[] {
  if (![3, 5].includes(args.length) || typeof args[0] !== "string" || !args[0].startsWith("/") ||
    args[0].length > 4096 || /[\u0000-\u001f\u007f]/.test(args[0]) ||
    typeof args[1] !== "string" || !/^[a-f0-9]{40,64}$/.test(args[1]) ||
    typeof args[2] !== "string" || !/^pacer\/[A-Za-z0-9._/-]+$/.test(args[2]) ||
    args[2].includes("..") || args[2].includes("//") ||
    (args.length === 5 && (typeof args[3] !== "string" || !/^[a-f0-9]{40}$/.test(args[3]) ||
      typeof args[4] !== "string" || !/^[a-f0-9]{64}$/.test(args[4]))))
    throw Error("invalid host-issued preflight tuple");
  return issuedArgv(sshTarget, controlPath, PREFLIGHT_SCRIPT, [...args]);
}

export function setIdentityArgv(sshTarget: string, controlPath: string, args: readonly string[], completionNonce: string): string[] {
  if (args.length !== 3 || typeof args[0] !== "string" ||
    !(args[0].startsWith("/") || args[0].startsWith("~/")) || args[0].length > 4096 ||
    args.slice(1).some(value => typeof value !== "string" || !value || value.length > 256) ||
    args.some(value => /[\u0000-\u001f\u007f]/.test(value)) ||
    !/^[a-f0-9-]{36}$/.test(completionNonce))
    throw Error("invalid host-issued identity tuple");
  return issuedArgv(sshTarget, controlPath, SET_IDENTITY_SCRIPT, [...args], completionNonce);
}

export function questionArgv(sshTarget: string, controlPath: string, args: readonly string[]): string[] {
  if (args.length !== 1 || typeof args[0] !== "string" || !args[0].startsWith("/") ||
    args[0].length > 4096 || /[\u0000-\u001f\u007f]/.test(args[0]))
    throw Error("invalid host-issued question tuple");
  return issuedArgv(sshTarget, controlPath, QUESTION_SCRIPT, [...args]);
}

export function usageArgv(sshTarget: string, controlPath: string, args: readonly string[]): string[] {
  if (args.length > 1 || (args.length === 1 &&
    (typeof args[0] !== "string" || args[0].length > 4096 ||
      !(args[0].startsWith("/") || args[0].startsWith("~/")) ||
      /[\u0000-\u001f\u007f]/.test(args[0]))))
    throw Error("invalid host-issued Codex usage home");
  return issuedArgv(sshTarget, controlPath, CODEX_USAGE_SCRIPT, [...args]);
}

/** Login-shell chatter is not part of the fixed script's output. */
export function probePayload(stdout: string): string {
  const marker = "__PACER_BEGIN__\n";
  const at = stdout.search(/^__PACER_BEGIN__\n/m);
  if (at < 0) throw Error("remote probe payload sentinel missing");
  return stdout.slice(at + marker.length);
}
