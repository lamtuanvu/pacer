#!/usr/bin/env bash
# orchestrator-multi.sh — Multi-executor orchestration script
# Backends: orca (default; supervised Orca workers) or tmux (legacy windows).
# Executors: claude, codex, cursor-agent (alias: cursor), opencode; tmux also takes op-glm or any CLI.

set -euo pipefail

BACKEND="${ORCHESTRATOR_BACKEND:-orca}"
ORCA_BIN="${ORCA_CLI_COMMAND:-orca}"

usage() {
    cat <<'EOF'
Usage: orchestrator-multi.sh <command> [args...]

Commands:
  init <session> [repo-path]                              Create session metadata (+ Orca Run or tmux session)
  spawn <session> <name> <repo-path> <ctx-file> <executor> <prompt>
                                                          Start a worker in <repo-path> with the context file + prompt
  spawn-speckit <session> <name> <repo-path> <ctx-file> <executor> <feature-description>
                                                          Start a claude worker running the SpecKit pipeline
  monitor <session>                                       Report state per worker
  status <session>                                        Alias for monitor
  capture-window <session> <name> [lines]                 Read recent worker output
  send <session> <name> <message>                         Message a worker (orca only; delivered between turns)
  focus <session> <name>                                  Show the worker's terminal in Orca (orca only)
  stop <session> <name>                                   Stop a worker's agent (worktree is kept)
  advance <session> [--force]                             Capture output, release workers, increment layer

Backends (ORCHESTRATOR_BACKEND):
  orca (default)  Each worker is an Orca supervised worker in its worktree: visible as a tab in Orca,
                  reports worker_done to the coordinator, and is driven with send/stop/focus.
  tmux            Each worker is a tmux window; completion is detected by a sentinel status file.

Executors:
  orca: claude, codex, cursor-agent (alias: cursor), opencode, or any agent id Orca knows
  tmux: claude, codex, cursor-agent (alias: cursor), op-glm, or any CLI accepting --prompt

State is stored at <repo>/.claude/feature-orchestrator/<session>/

Environment variables:
  ORCHESTRATOR_BACKEND      orca (default) or tmux
  ORCHESTRATOR_MODEL        Model id for orca workers (passed as --model)
  ORCHESTRATOR_EFFORT       Reasoning effort for orca workers (requires ORCHESTRATOR_MODEL)
  ORCHESTRATOR_KEEP_OPEN    1 (default) keeps finished orca workers open for follow-up; 0 lets them close
  CLAUDE_PERMISSION_MODE    tmux claude permission mode (default: acceptEdits)
  CLAUDE_MODEL              tmux claude model override
  EXECUTOR_ARGS             Additional args passed to the tmux executor
EOF
}

die() { echo "Error: $*" >&2; exit 1; }

# Resolve the meta directory for a session
meta_dir() {
    local session="$1"
    local symlink="/tmp/feature-orchestrator/${session}"

    if [[ -L "$symlink" ]] && [[ -d "$symlink" ]]; then
        echo "$symlink"
        return
    fi

    local repo_root
    repo_root="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
    if [[ -n "$repo_root" ]]; then
        local local_dir="${repo_root}/.claude/feature-orchestrator/${session}"
        if [[ -d "$local_dir" ]]; then
            echo "$local_dir"
            return
        fi
    fi

    echo "$symlink"
}

require_meta() {
    local meta="$1" session="$2"
    [[ -f "$meta/current_layer" ]] || die "Session '$session' is not initialized. Run 'init' first."
}

session_backend() {
    local meta="$1"
    if [[ -f "$meta/backend" ]]; then cat "$meta/backend"; else echo "tmux"; fi
}

# windows.txt rows: name|layer|repo|started|executor|dispatch_id|terminal (last two empty for tmux)
record_worker() {
    local meta="$1" name="$2" layer="$3" repo="$4" executor="$5" dispatch="${6:-}" terminal="${7:-}"
    local file="$meta/windows.txt"
    touch "$file"
    local tmp
    tmp="$(mktemp)"
    awk -F'|' -v n="$name" '$1 != n' "$file" > "$tmp" || true
    echo "${name}|${layer}|${repo}|$(date -u +%Y-%m-%dT%H:%M:%SZ)|${executor}|${dispatch}|${terminal}" >> "$tmp"
    command mv -f "$tmp" "$file"
}

worker_dispatch() {
    local meta="$1" name="$2"
    awk -F'|' -v n="$name" '$1 == n { d = $6 } END { print d }' "$meta/windows.txt" 2>/dev/null
}

require_dispatch() {
    local meta="$1" name="$2"
    local dispatch
    dispatch="$(worker_dispatch "$meta" "$name")"
    [[ -n "$dispatch" ]] || die "No Orca dispatch recorded for '$name'."
    echo "$dispatch"
}

# --- Orca backend ---

orca_agent_id() {
    case "$1" in
        cursor|cursor-agent) echo "cursor" ;;
        op-glm) die "op-glm is not an Orca agent; use ORCHESTRATOR_BACKEND=tmux" ;;
        *) echo "$1" ;;
    esac
}

orca_run_id() {
    local meta="$1"
    [[ -s "$meta/run_id" ]] || die "No Orca Run recorded in $meta/run_id. Run 'init' with the orca backend."
    cat "$meta/run_id"
}

orca_init() {
    local session="$1" meta="$2"
    if [[ -s "$meta/run_id" ]]; then
        echo "Reusing Orca Run $(cat "$meta/run_id")."
        return
    fi
    local out
    out="$("$ORCA_BIN" orchestration run-create --objective "feature-orchestrator: ${session}" --json)" \
        || die "orca run-create failed: $out"
    local run_id
    run_id="$(jq -r '.result.runId // .result.run.id // .result.run.runId // .result.id // empty' <<<"$out")"
    [[ -n "$run_id" ]] || die "Could not read the Run id from: $out"
    echo "$run_id" > "$meta/run_id"
    echo "Created Orca Run $run_id (bound to this terminal; workers report back here)."
}

orca_spawn() {
    local session="$1" name="$2" repo_path="$3" ctx_file="$4" executor="$5" prompt="$6" meta="$7"
    local run_id agent
    run_id="$(orca_run_id "$meta")"
    agent="$(orca_agent_id "$executor")"

    local existing
    existing="$(worker_dispatch "$meta" "$name")"
    if [[ -n "$existing" ]]; then
        local state
        state="$("$ORCA_BIN" orchestration worker-show --dispatch "$existing" --json 2>/dev/null \
            | jq -r '.result.worker.state // .result.state // empty' || true)"
        case "$state" in
            ""|completed|failed|stopped|abandoned|released) ;;
            *) die "'$name' already has dispatch $existing in state '$state'. Stop it first: $0 stop $session $name" ;;
        esac
    fi

    mkdir -p "$meta/specs"
    local spec_file="$meta/specs/${name}.md"
    { cat "$ctx_file"; printf '\n\n'; printf '%s\n' "$prompt"; } > "$spec_file"

    local args=(orchestration worker-start --spec-file "$spec_file" --worktree "path:${repo_path}"
        --agent "$agent" --task-title "$name" --run "$run_id" --json)
    [[ "${ORCHESTRATOR_KEEP_OPEN:-1}" == "1" ]] && args+=(--keep-open)
    [[ -n "${ORCHESTRATOR_MODEL:-}" ]] && args+=(--model "$ORCHESTRATOR_MODEL")
    [[ -n "${ORCHESTRATOR_EFFORT:-}" ]] && args+=(--effort "$ORCHESTRATOR_EFFORT")

    local out rc=0
    out="$("$ORCA_BIN" "${args[@]}")" || rc=$?
    local dispatch
    dispatch="$(jq -r '.result.dispatchId // .result.dispatch.id // .result.dispatch.dispatchId // .result.worker.dispatchId // empty' <<<"$out" 2>/dev/null || true)"
    if [[ $rc -ne 0 || -z "$dispatch" ]]; then
        echo "$out" >&2
        die "worker-start failed for '$name' (exit $rc). Do not rerun blindly; check failedStage above."
    fi

    local terminal
    terminal="$("$ORCA_BIN" orchestration worker-show --dispatch "$dispatch" --json 2>/dev/null \
        | jq -r '.result.terminal // .result.worker.terminal // empty' || true)"

    local layer
    layer="$(cat "$meta/current_layer")"
    record_worker "$meta" "$name" "$layer" "$repo_path" "$executor" "$dispatch" "$terminal"
    echo "running" > "$meta/state"

    echo "Started Orca worker ${name} (agent ${agent}, layer ${layer})"
    echo "  Dispatch: ${dispatch}"
    echo "  Worktree: ${repo_path}"
    echo "  Spec:     ${spec_file}"
}

orca_monitor() {
    local session="$1" meta="$2"
    local run_id
    run_id="$(orca_run_id "$meta")"
    local list
    list="$("$ORCA_BIN" orchestration worker-list --run "$run_id" --limit 100 --json)" \
        || die "orca worker-list failed: $list"

    echo "=== Session: $session (Orca Run $run_id) ==="
    local total=0 active=0 done_ok=0 failed=0 waiting=0
    while IFS='|' read -r name _layer _repo _started executor dispatch recorded_terminal; do
        [[ -z "$name" ]] && continue
        total=$((total + 1))
        if [[ -z "$dispatch" ]]; then
            echo "UNTRACKED|$name|executor=$executor"
            continue
        fi
        # Follow-ups sent to a finished worker run as new dispatches on the same terminal;
        # worker-list is newest first, so report the newest dispatch on that terminal.
        local row
        row="$(jq -c --arg d "$dispatch" --arg t "${recorded_terminal:-}" '
            (.result.workers // []) as $w
            | ($w | map(select(.dispatchId == $d)) | first) as $orig
            | (if $t != "" then $t else ($orig.terminal // "") end) as $term
            | if $term != "" and ($w | any(.terminal == $term))
              then ($w | map(select(.terminal == $term)) | first)
              else ($orig // empty) end' <<<"$list")"
        if [[ -z "$row" ]]; then
            row="$("$ORCA_BIN" orchestration worker-show --dispatch "$dispatch" --json 2>/dev/null \
                | jq -c '.result.worker // .result' || echo '{}')"
        fi
        local state liveness attention terminal
        dispatch="$(jq -r --arg d "$dispatch" '.dispatchId // $d' <<<"$row")"
        state="$(jq -r '.state // "unknown"' <<<"$row")"
        liveness="$(jq -r '.liveness // "?"' <<<"$row")"
        attention="$(jq -r '(.attention // []) | join(",")' <<<"$row")"
        terminal="$(jq -r '.terminal // ""' <<<"$row")"
        case "$state" in
            completed|succeeded) done_ok=$((done_ok + 1)) ;;
            failed|stopped|abandoned) failed=$((failed + 1)) ;;
            *) active=$((active + 1)) ;;
        esac
        [[ "$attention" == *wait* ]] && waiting=$((waiting + 1))
        echo "$(tr '[:lower:]' '[:upper:]' <<<"$state")|$name|dispatch=$dispatch|liveness=$liveness|attention=${attention:-none}|terminal=$terminal"
    done < "$meta/windows.txt"
    echo "---"
    echo "SUMMARY|active=$active|completed=$done_ok|failed=$failed|needs_attention=$waiting|total=$total"
}

orca_capture() {
    local meta="$1" name="$2" lines="$3"
    local dispatch
    dispatch="$(require_dispatch "$meta" "$name")"
    "$ORCA_BIN" orchestration worker-read --dispatch "$dispatch" --limit "$lines"
}

orca_send() {
    local meta="$1" name="$2" message="$3"
    local dispatch
    dispatch="$(require_dispatch "$meta" "$name")"
    "$ORCA_BIN" orchestration send --to "dispatch:${dispatch}" --subject "coordinator: ${name}" --body "$message" --json
}

orca_focus() {
    local meta="$1" name="$2"
    local dispatch terminal
    dispatch="$(require_dispatch "$meta" "$name")"
    terminal="$("$ORCA_BIN" orchestration worker-show --dispatch "$dispatch" --json \
        | jq -r '.result.worker.terminal // .result.terminal // empty')"
    [[ -n "$terminal" ]] || die "Worker '$name' has no terminal to show (it may be a chat tab; open its worktree in Orca)."
    "$ORCA_BIN" terminal switch --terminal "$terminal" --json
}

orca_stop() {
    local meta="$1" name="$2"
    local dispatch
    dispatch="$(require_dispatch "$meta" "$name")"
    "$ORCA_BIN" orchestration worker-stop --dispatch "$dispatch" --json
}

orca_advance() {
    local session="$1" meta="$2" force="$3"
    local layer
    layer="$(cat "$meta/current_layer")"
    local run_id list
    run_id="$(orca_run_id "$meta")"
    list="$("$ORCA_BIN" orchestration worker-list --run "$run_id" --limit 100 --json)"

    local blocked=()
    while IFS='|' read -r name _layer _repo _started _executor dispatch _terminal; do
        [[ -z "$name" || -z "$dispatch" ]] && continue
        local state
        state="$(jq -r --arg d "$dispatch" '.result.workers[]? | select(.dispatchId == $d) | .state' <<<"$list")"
        case "$state" in
            completed|succeeded|failed|stopped|abandoned|"") ;;
            *) blocked+=("$name($state)") ;;
        esac
    done < "$meta/windows.txt"
    if [[ ${#blocked[@]} -gt 0 && "$force" != "--force" ]]; then
        die "Workers still active: ${blocked[*]}. Wait, stop them, or pass --force."
    fi

    while IFS='|' read -r name _layer _repo _started _executor dispatch _terminal; do
        [[ -z "$name" || -z "$dispatch" ]] && continue
        "$ORCA_BIN" orchestration worker-read --dispatch "$dispatch" --limit 500 \
            > "$meta/captures/layer${layer}-${name}.txt" 2>&1 || true
        if [[ "$force" == "--force" ]]; then
            "$ORCA_BIN" orchestration worker-stop --dispatch "$dispatch" --json >/dev/null 2>&1 || true
        fi
        "$ORCA_BIN" orchestration worker-release --dispatch "$dispatch" --json >/dev/null 2>&1 || true
    done < "$meta/windows.txt"

    cp "$meta/windows.txt" "$meta/layers/layer${layer}-workers.txt" 2>/dev/null || true
    echo $((layer + 1)) > "$meta/current_layer"
    : > "$meta/windows.txt"
    echo "initialized" > "$meta/state"
    echo "Advanced from layer $layer to layer $((layer + 1)). Output captured under $meta/captures/; worker terminals released."
}

# --- tmux backend ---

# Build wrapper command with sentinel file
build_wrapper() {
    local session="$1"
    local window="$2"
    local repo_path="$3"
    local executor_cmd="$4"
    local meta
    meta="$(meta_dir "$session")"

    local status_dir="$meta/status"
    mkdir -p "$status_dir"

    cat <<WRAPPER_EOF
cd $(printf '%q' "$repo_path") && \\
${executor_cmd}; \\
_exit_code=\$?; \\
_ts=\$(date -u +%Y-%m-%dT%H:%M:%SZ); \\
_win_lower=\$(echo '${window}' | tr '[:upper:]' '[:lower:]'); \\
_worktrees=\$(git worktree list 2>/dev/null | grep -ci "\$_win_lower" || echo 0); \\
_branch=\$(git branch --list "*\${_win_lower}*" 2>/dev/null | head -1 | sed 's/^[* ]*//' || echo ''); \\
_commits=0; \\
if [ -n "\$_branch" ]; then _commits=\$(git rev-list --count HEAD --not \$(git merge-base HEAD master 2>/dev/null || echo HEAD) 2>/dev/null || echo 0); fi; \\
echo "{\"exit_code\":\$_exit_code,\"finished_at\":\"\$_ts\",\"worktrees\":\$_worktrees,\"branch\":\"\$_branch\",\"commits\":\$_commits}" > $(printf '%q' "$status_dir/${window}.json"); \\
echo "--- ORCHESTRATOR: ${window} finished (exit=\$_exit_code) at \$_ts ---"
WRAPPER_EOF
}

# Build executor command based on executor type
build_executor_cmd() {
    local executor="$1"
    local ctx_file="$2"
    local prompt="$3"
    local extra_args="${EXECUTOR_ARGS:-}"

    case "$executor" in
        claude)
            local permission_mode="${CLAUDE_PERMISSION_MODE:-acceptEdits}"
            local claude_args="--permission-mode ${permission_mode}"
            claude_args+=" --append-system-prompt \"\$(cat $(printf '%q' "$ctx_file"))\""
            if [[ -n "${CLAUDE_MODEL:-}" ]]; then
                claude_args+=" --model ${CLAUDE_MODEL}"
            fi
            claude_args+=" ${extra_args}"
            claude_args+=" $(printf '%q' "$prompt")"
            echo "claude ${claude_args}"
            ;;
        codex)
            echo "codex exec ${extra_args} $(printf '%q' "$prompt")"
            ;;
        cursor|cursor-agent)
            # The `cursor` binary is the desktop app; headless work needs cursor-agent.
            # cursor-agent has no system-prompt flag, so the context file is prepended to the prompt.
            local cursor_args="-p --output-format text --trust --force"
            cursor_args+=" ${extra_args}"
            echo "cursor-agent ${cursor_args} \"\$(cat $(printf '%q' "$ctx_file"); echo; echo; printf '%s' $(printf '%q' "$prompt"))\""
            ;;
        op-glm)
            echo "op-glm ${extra_args} --prompt $(printf '%q' "$prompt")"
            ;;
        *)
            echo "${executor} ${extra_args} --prompt $(printf '%q' "$prompt")"
            ;;
    esac
}

tmux_spawn() {
    local session="$1" window="$2" repo_path="$3" ctx_file="$4" executor="$5" prompt="$6" meta="$7"

    tmux has-session -t "$session" 2>/dev/null || die "tmux session '$session' does not exist. Run 'init' first."

    if tmux list-windows -t "$session" -F '#{window_name}' | grep -q "^${window}$"; then
        echo "Window '$window' already exists in session '$session'. Killing existing window."
        tmux kill-window -t "${session}:${window}" 2>/dev/null || true
    fi

    local executor_cmd wrapper_cmd
    executor_cmd=$(build_executor_cmd "$executor" "$ctx_file" "$prompt")
    wrapper_cmd=$(build_wrapper "$session" "$window" "$repo_path" "$executor_cmd")

    rm -f "$meta/status/${window}.json"

    tmux new-window -t "$session" -n "$window" -c "$repo_path"
    tmux send-keys -t "${session}:${window}" "$wrapper_cmd" Enter

    local layer
    layer="$(cat "$meta/current_layer")"
    record_worker "$meta" "$window" "$layer" "$repo_path" "$executor"
    echo "running" > "$meta/state"

    echo "Spawned ${executor} in ${session}:${window} (layer ${layer})"
    echo "  Repo: ${repo_path}"
    echo "  Context: ${ctx_file}"
}

tmux_monitor() {
    local session="$1" meta="$2"
    local running=0 complete=0 errored=0 total=0
    echo "=== Session: $session (tmux) ==="
    while IFS='|' read -r window _layer _repo _started executor _dispatch _terminal; do
        [[ -z "$window" ]] && continue
        total=$((total + 1))
        local status_file="$meta/status/${window}.json"
        if [[ -f "$status_file" ]]; then
            local exit_code finished branch
            exit_code=$(jq -r '.exit_code' "$status_file" 2>/dev/null || echo "?")
            finished=$(jq -r '.finished_at' "$status_file" 2>/dev/null || echo "?")
            branch=$(jq -r '.branch' "$status_file" 2>/dev/null || echo "?")
            if [[ "$exit_code" == "0" ]]; then
                echo "COMPLETE|$window|finished=$finished|branch=$branch"
                complete=$((complete + 1))
            else
                echo "ERRORED|$window|exit=$exit_code|finished=$finished|branch=$branch"
                errored=$((errored + 1))
            fi
        else
            local pane_cmd
            pane_cmd=$(tmux list-panes -t "${session}:${window}" -F '#{pane_current_command}' 2>/dev/null | head -1 || echo "unknown")
            if [[ "$pane_cmd" =~ ^(claude|codex|cursor-agent|node|op-glm|zsh|bash|fish)$ ]]; then
                echo "RUNNING|$window|executor=$executor|pane=$pane_cmd"
                running=$((running + 1))
            else
                echo "UNKNOWN|$window|executor=$executor|pane=$pane_cmd"
            fi
        fi
    done < "$meta/windows.txt"

    echo "---"
    echo "SUMMARY|running=$running|complete=$complete|errored=$errored|total=$total"
}

tmux_advance() {
    local session="$1" meta="$2"
    tmux has-session -t "$session" 2>/dev/null || die "tmux session '$session' does not exist."

    local layer
    layer="$(cat "$meta/current_layer")"
    while IFS='|' read -r window _rest; do
        [[ -z "$window" ]] && continue
        tmux capture-pane -t "${session}:${window}" -p > "$meta/captures/layer${layer}-${window}.txt" 2>/dev/null || true
        tmux kill-window -t "${session}:${window}" 2>/dev/null || true
    done < "$meta/windows.txt"

    echo $((layer + 1)) > "$meta/current_layer"
    : > "$meta/windows.txt"
    echo "initialized" > "$meta/state"
    echo "Advanced from layer $layer to layer $((layer + 1)). All windows captured and killed."
}

# --- Commands ---

cmd_init() {
    local session="${1:?Session name required}"
    local repo_path="${2:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

    local meta="${repo_path}/.claude/feature-orchestrator/${session}"
    mkdir -p "$meta/layers" "$meta/captures" "$meta/status" "$meta/specs"

    mkdir -p /tmp/feature-orchestrator
    ln -sfn "$meta" "/tmp/feature-orchestrator/${session}"

    [[ -f "$meta/current_layer" ]] || echo "0" > "$meta/current_layer"
    [[ -f "$meta/windows.txt" ]] || : > "$meta/windows.txt"
    echo "initialized" > "$meta/state"

    local previous
    previous="$(session_backend "$meta")"
    if [[ "$previous" != "$BACKEND" && -s "$meta/windows.txt" ]]; then
        echo "Switching session backend from $previous to $BACKEND; clearing the worker list."
        : > "$meta/windows.txt"
    fi
    echo "$BACKEND" > "$meta/backend"

    case "$BACKEND" in
        orca) orca_init "$session" "$meta" ;;
        tmux)
            if tmux has-session -t "$session" 2>/dev/null; then
                echo "tmux session '$session' already exists. Reusing."
            else
                tmux new-session -d -s "$session" -n control
                echo "Created tmux session '$session' with control window."
            fi
            ;;
        *) die "Unknown backend '$BACKEND' (expected orca or tmux)" ;;
    esac

    echo "Metadata directory: $meta"
    echo "Backend: $BACKEND | Layer: $(cat "$meta/current_layer")"
}

cmd_spawn() {
    local session="${1:?Session name required}"
    local name="${2:?Worker name required}"
    local repo_path="${3:?Repo path required}"
    local ctx_file="${4:?Context file required}"
    local executor="${5:-claude}"
    local prompt="${6:?Prompt required}"
    local meta
    meta="$(meta_dir "$session")"
    require_meta "$meta" "$session"
    [[ -f "$ctx_file" ]] || die "Context file not found: $ctx_file"
    [[ -d "$repo_path" ]] || die "Repo path not found: $repo_path"

    case "$(session_backend "$meta")" in
        orca) orca_spawn "$session" "$name" "$repo_path" "$ctx_file" "$executor" "$prompt" "$meta" ;;
        *)    tmux_spawn "$session" "$name" "$repo_path" "$ctx_file" "$executor" "$prompt" "$meta" ;;
    esac
}

cmd_spawn_speckit() {
    local session="${1:?Session name required}"
    local name="${2:?Worker name required}"
    local repo_path="${3:?Repo path required}"
    local ctx_file="${4:?Context file required}"
    local executor="${5:-claude}"
    local feature_desc="${6:?Feature description required}"
    [[ "$executor" == "claude" ]] || die "SpecKit mode only works with the 'claude' executor"
    cmd_spawn "$session" "$name" "$repo_path" "$ctx_file" claude "Run /speckit-orchestrator:brainstorm ${feature_desc}"
}

cmd_monitor() {
    local session="${1:?Session name required}"
    local meta
    meta="$(meta_dir "$session")"
    require_meta "$meta" "$session"
    case "$(session_backend "$meta")" in
        orca) orca_monitor "$session" "$meta" ;;
        *)    tmux_monitor "$session" "$meta" ;;
    esac
}

cmd_capture_window() {
    local session="${1:?Session name required}"
    local name="${2:?Worker name required}"
    local lines="${3:-200}"
    local meta
    meta="$(meta_dir "$session")"
    require_meta "$meta" "$session"
    case "$(session_backend "$meta")" in
        orca) orca_capture "$meta" "$name" "$lines" ;;
        *)    tmux capture-pane -t "${session}:${name}" -p | tail -"$lines" ;;
    esac
}

cmd_send() {
    local session="${1:?Session name required}"
    local name="${2:?Worker name required}"
    local message="${3:?Message required}"
    local meta
    meta="$(meta_dir "$session")"
    require_meta "$meta" "$session"
    [[ "$(session_backend "$meta")" == "orca" ]] || die "send needs the orca backend"
    orca_send "$meta" "$name" "$message"
}

cmd_focus() {
    local session="${1:?Session name required}"
    local name="${2:?Worker name required}"
    local meta
    meta="$(meta_dir "$session")"
    require_meta "$meta" "$session"
    case "$(session_backend "$meta")" in
        orca) orca_focus "$meta" "$name" ;;
        *)    tmux select-window -t "${session}:${name}" ;;
    esac
}

cmd_stop() {
    local session="${1:?Session name required}"
    local name="${2:?Worker name required}"
    local meta
    meta="$(meta_dir "$session")"
    require_meta "$meta" "$session"
    case "$(session_backend "$meta")" in
        orca) orca_stop "$meta" "$name" ;;
        *)    tmux kill-window -t "${session}:${name}" && echo "Killed tmux window ${session}:${name}" ;;
    esac
}

cmd_advance() {
    local session="${1:?Session name required}"
    local force="${2:-}"
    local meta
    meta="$(meta_dir "$session")"
    require_meta "$meta" "$session"
    case "$(session_backend "$meta")" in
        orca) orca_advance "$session" "$meta" "$force" ;;
        *)    tmux_advance "$session" "$meta" ;;
    esac
}

# --- Main ---
case "${1:-}" in
    init)           shift; cmd_init "$@" ;;
    spawn)          shift; cmd_spawn "$@" ;;
    spawn-speckit)  shift; cmd_spawn_speckit "$@" ;;
    monitor|status) shift; cmd_monitor "$@" ;;
    capture-window) shift; cmd_capture_window "$@" ;;
    send)           shift; cmd_send "$@" ;;
    focus)          shift; cmd_focus "$@" ;;
    stop)           shift; cmd_stop "$@" ;;
    advance)        shift; cmd_advance "$@" ;;
    -h|--help|"")   usage ;;
    *) echo "Unknown command: $1"; usage; exit 1 ;;
esac
