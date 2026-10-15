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
  line=$(tail -n 4000 "$file" | grep '"rate_limits"' | tail -1)
  [ -n "$line" ] || continue
  printf 'mtime=%s\\n%s\\n' "$mtime" "$line"
  break
done`,
  PROBE: `printf 'git=%s\\n' "$(git --version)"
printf 'codex=%s\\n' "$(command -v codex || true)"
printf 'claude=%s\\n' "$(command -v claude || true)"
printf 'setsid=%s\\n' "$(command -v setsid || true)"
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
  PREPARE: `checkout="$1"; tag="$2"; task="$3"; base="$4"; branch="$5"
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
worktree="$HOME/.pacer-remote/worktrees/$tag/$task"
mkdir -p "$HOME/.pacer-remote/worktrees/$tag" || exit 1
git worktree add -q -b "pacer/$task" "$worktree" "$base" || exit 1
printf 'worktree=%s\\n' "$worktree"`,
  PREFLIGHT: `cd "$1" || exit 1
base="$2"; branch="pacer/$3"
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
git bundle create - "$2..pacer/$3"`,
  CLEAN: `worktree="$1"; D="$2"; checkout="$3"; task="$4"
case "$worktree" in '~/'*) worktree="$HOME/\${worktree#??}" ;; esac
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
case "$checkout" in '~/'*) checkout="$HOME/\${checkout#??}" ;; esac
cd "$checkout" || exit 1
if [ -d "$worktree" ]; then git worktree remove --force "$worktree" || exit 1; fi
rm -rf "$D" || exit 1
if [ -n "$task" ] && git show-ref --verify --quiet "refs/heads/pacer/$task"; then
  git branch -D "pacer/$task" || exit 1
fi`,
  START: `D="$1"; cwd="$2"; shift 2
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
case "$cwd" in '~/'*) cwd="$HOME/\${cwd#??}" ;; esac
mkdir -p "$D" || exit 1
chmod 700 "$D"
rm -f "$D/pid" "$D/pid.tmp" "$D/child" "$D/started" "$D/exit" "$D/exit.tmp" "$D/stdout" "$D/stderr"
# Read only the wrapper as lines; cat preserves every byte of the remaining prompt.
: > "$D/run.sh"
while IFS= read -r line; do
  [ "$line" = '__PACER_STDIN__' ] && break
  printf '%s\\n' "$line" >> "$D/run.sh"
done
cat > "$D/stdin"
chmod 700 "$D/run.sh"
chmod 600 "$D/stdin"
cd "$cwd" || exit 1
setsid nohup env -i HOME="$HOME" PATH="$PATH" sh -c '
D="$1"; shift
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  pair="$1"; key=\${pair%%=*}; value=\${pair#*=}
  case "$value" in "~/"*) value="$HOME/\${value#??}" ;; esac
  export "$key=$value"
  shift
done
shift
exec sh "$D/run.sh" "$D" "$@"
' pacer "$D" "$@" </dev/null >/dev/null 2>&1 &
n=0
while [ ! -s "$D/pid" ] && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
[ -s "$D/pid" ] || exit 1
printf 'pid=%s\\n' "$(cat "$D/pid")"`,
  REPORT: `D="$1"
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
pid=$(cat "$D/pid" 2>/dev/null); alive=0
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  case "$(ps -o args= -p "$pid")" in *"$D/run.sh"*) alive=1 ;; esac
fi
printf 'pid=%s\\nalive=%s\\nexit=%s\\nstarted=%s\\n' "$pid" "$alive" "$(cat "$D/exit" 2>/dev/null)" "$(cat "$D/started" 2>/dev/null)"
for stream in stdout stderr; do
  bytes=0; stamp=''
  if [ -f "$D/$stream" ]; then
    bytes=$(wc -c < "$D/$stream" | tr -d ' ')
    stamp=$(stat -c %Y "$D/$stream" 2>/dev/null) || stamp=$(stat -f %m "$D/$stream" 2>/dev/null)
  fi
  case "$stream" in stdout) key=out ;; stderr) key=err ;; esac
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
  STOP: `D="$1"; grace="$2"
case "$D" in '~/'*) D="$HOME/\${D#??}" ;; esac
if [ -f "$D/exit" ]; then printf 'code=%s\\nkilled=0\\n' "$(cat "$D/exit")"; exit 0; fi
pid=$(cat "$D/pid" 2>/dev/null)
case "$pid" in ''|*[!0-9]*) printf 'code=137\\nkilled=0\\n'; exit 0 ;; esac
case "$(ps -o args= -p "$pid")" in *"$D/run.sh"*) ;; *) printf 'code=137\\nkilled=0\\n'; exit 0 ;; esac
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
