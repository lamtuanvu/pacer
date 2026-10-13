#!/bin/sh
# Run inside the TEST account's Terminal at any point. Read-only: it changes nothing.
#   sh /Users/Shared/pacer-onboarding-test/check.sh   (staged by stage.sh)
# or, without staging: sh scripts/onboarding-test/check.sh from a pacer checkout.
# Prints PASS/FAIL/WAIT for each onboarding step and exits non-zero on a FAIL.
fail=0
pass() { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }
wait_() { printf 'WAIT  %s\n' "$1"; }

bin="$HOME/.local/bin/pacer"
if [ -x "$bin" ]; then pass "binary installed: $("$bin" --version 2>/dev/null)"; else bad "binary missing at $bin"; fi

if [ -f "$HOME/.pacer/strategy.yaml" ]; then pass "strategy created (~/.pacer/strategy.yaml)"; else bad "no ~/.pacer/strategy.yaml"; fi

plist="$HOME/Library/LaunchAgents/com.pacer.serve.plist"
if [ -f "$plist" ]; then pass "login service installed"; else bad "no $plist"; fi
if launchctl print "gui/$(id -u)/com.pacer.serve" 2>/dev/null | grep -q "state = running"; then pass "service running"; else bad "service not running (launchctl)"; fi

code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:4317/health)
if [ "$code" = 200 ]; then pass "link healthy (127.0.0.1:4317/health)"; else bad "link not healthy (HTTP $code)"; fi

data="$HOME/Library/Application Support/orca/plugins-data/lamtuanvu.pacer/storage.json"
if [ -f "$data" ] && command -v plutil >/dev/null; then
  # storage.json is JSON; plutil can read it without jq.
  for step in install start; do
    s=$(plutil -extract "bootstrap.$step.status" raw -o - "$data" 2>/dev/null || echo "?")
    case "$s" in done) pass "plugin checklist: $step done";; failed) bad "plugin checklist: $step failed: $(plutil -extract "bootstrap.$step.detail" raw -o - "$data" 2>/dev/null)";; *) wait_ "plugin checklist: $step $s";; esac
  done
else
  wait_ "plugin has not saved its checklist yet (is it enabled?)"
fi

# Agent consent: nothing may be touched before the click.
manifest="$HOME/.pacer/install-manifest.json"
for agent in claude-code codex cursor opencode; do
  if [ -f "$manifest" ] && grep -q "\"$agent\"" "$manifest"; then
    pass "agent connected: $agent"
  else
    printf 'INFO  agent not connected: %s\n' "$agent"
  fi
done
for f in "$HOME/.claude/skills/pacer/SKILL.md" "$HOME/.codex/skills/pacer/SKILL.md"; do
  [ -f "$f" ] && printf 'INFO  present: %s\n' "$f"
done
if command -v claude >/dev/null && claude mcp list 2>/dev/null | grep -qi '^pacer'; then bad "pacer MCP registered for Claude (setup must not add MCP)"; fi

exit $fail
