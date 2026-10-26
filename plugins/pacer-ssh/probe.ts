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
  if (args.length !== 3 || typeof args[0] !== "string" || !args[0].startsWith("/") ||
    args[0].length > 4096 || /[\u0000-\u001f\u007f]/.test(args[0]) ||
    typeof args[1] !== "string" || !/^[a-f0-9]{40,64}$/.test(args[1]) ||
    typeof args[2] !== "string" || !/^pacer\/[A-Za-z0-9._/-]+$/.test(args[2]) ||
    args[2].includes("..") || args[2].includes("//"))
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

/** Login-shell chatter is not part of the fixed script's output. */
export function probePayload(stdout: string): string {
  const marker = "__PACER_BEGIN__\n";
  const at = stdout.search(/^__PACER_BEGIN__\n/m);
  if (at < 0) throw Error("remote probe payload sentinel missing");
  return stdout.slice(at + marker.length);
}
