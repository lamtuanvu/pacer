import { expect, test } from 'bun:test';
import { clock } from '../src/view-model/format';
import { reasonCopy, costCopy, kindCopy, kindSourceCopy, timelineCopy, sessionTime, branchCopy, executorIdHelp, askModeCheckCopy, isAskModeCheckReason, ASSISTANT_LIVE_TOOLS_PHRASE, ASSISTANT_SUMMARY_ONLY_PHRASE, ASSISTANT_READS_SUMMARY_ONLY, executorAssistantDescription, executorSetupToolsCopy, assistantBackendChoiceLabel, assistantCliName } from '../src/view-model/copy';
const now = Date.parse('2026-10-19T03:24:00Z') / 1000;
test('one clock distinguishes local calendar days, yesterday and a full week', () => {
  const at = (s: string) => Date.parse(s) / 1000;
  const format = (s: string) => clock(at(s), now, 'Asia/Ho_Chi_Minh');
  expect(format('2026-10-19T03:24:00Z')).toBe('10:24');
  expect(format('2026-10-18T03:24:00Z')).toBe('Yesterday 10:24');
  expect(format('2026-10-13T03:24:00Z')).toBe('Tue 10:24');
  expect(format('2026-10-12T03:24:00Z')).toBe('12 Oct 10:24');
  expect(clock(at('2026-10-18T16:59:00Z'), at('2026-10-18T17:01:00Z'), 'Asia/Ho_Chi_Minh')).toBe('Yesterday 23:59');
  expect(clock(at('2026-03-08T06:30:00Z'), at('2026-03-09T04:15:00Z'), 'America/New_York')).toBe('Yesterday 01:30');
});
test('internal routing strings get useful copy with a safe fallback', () => {
  expect(reasonCopy('ok, used 0%; codex busy')).toBe('Available capacity · 0% of quota used; Codex is busy');
  expect(reasonCopy('exhausted')).toBe('Out of quota');
  expect(reasonCopy('unknown_internal_code')).toBe('Routing details available');
  expect(reasonCopy('busy')).toBe('Busy with another task');
});
test('cost, classifier, branch and executor preview copy are plain language', () => {
  expect(costCopy({account:'cursor',deltaPct:0,window:'limit'})).toBe('Cursor · no measured quota increase');
  expect(costCopy({account:'codex',deltaPct:2,window:'weekly'})).toBe('Codex · used 2% of weekly quota');
  expect(costCopy({account:'cursor',deltaPct:null,window:null,reason:'shared'})).toContain('shared');
  expect(kindCopy('unfamiliar-code')).toBe('Explore unfamiliar code');
  expect(kindCopy('new_enum')).toBe('Other work');
  expect(kindSourceCopy('brief')).toBe('Chosen in the task brief');
  expect(kindSourceCopy('classifier')).toBe('Suggested from the task description');
  expect(branchCopy(null)).toBe('Branch not recorded');
  expect(executorIdHelp(false)).toContain('final id');
});
test('timeline names and hooks map once; raw unknown events stay out of visible copy', () => {
  expect(timelineCopy([{at:1,text:'hook: PostToolUse'},{at:1,text:'hook: PostToolUse'},{at:2,text:'Testing'},{at:3,text:'partial'},{at:4,text:'raw_internal'}]).map(e=>e.text)).toEqual(['Agent finished a tool step','Running checks','Run ended with work to review','Session activity recorded']);
});
test('session durations describe running time or time since a terminal update', () => {
  expect(sessionTime({state:'running',attemptStartedAt:now-1500,updatedAt:now},now)).toBe('running for 25m');
  expect(sessionTime({state:'partial',attemptStartedAt:now-3000,updatedAt:now-1500},now)).toBe('last updated 25m ago');
  expect(sessionTime({state:'queued',updatedAt:now-60},now)).toBe('queued for 1m');
});

test('unknown values including object property names never bypass copy fallbacks',()=>{
  for(const value of ['constructor','__proto__','toString']) {
    expect(kindCopy(value)).toBe('Other work');
    expect(timelineCopy([{at:1,text:value}])[0]!.text).toBe('Session activity recorded');
    expect(costCopy({account:'cursor',deltaPct:2,window:value})).toBe('Cursor · used 2% of quota');
  }
});

test('job progress labels describe checks and state without internal operation strings', async()=>{
 const {jobKindCopy,jobStateCopy}=await import('../src/view-model/copy');
 expect(jobKindCopy('runner.check')).toBe('Executor check');
 expect(jobKindCopy('host.repo.setup')).toBe('Repository setup');
 expect(jobStateCopy('running')).toBe('In progress');
 expect(jobStateCopy('passed')).toBe('Passed');
 expect(jobStateCopy('pending')).toBe('Waiting');
 expect(jobKindCopy('new_future.operation')).toBe('New future operation');
 expect(jobStateCopy('future_state')).toBe('Future state');
});

test('ask-mode check reasons map to plain sentences; unknown falls back', () => {
  const cases: [string | null | undefined, string][] = [
    [null, 'Not checked yet.'],
    [undefined, 'Not checked yet.'],
    ['oc has not passed the ask-mode check yet.', 'Not checked yet.'],
    ['opencode is not installed or did not report its version', "The agent CLI isn't installed, or didn't report its version."],
    ['oc failed the ask-mode check: opencode is not installed or did not report its version', "The agent CLI isn't installed, or didn't report its version."],
    ['claude is not installed or did not report its version', "The agent CLI isn't installed, or didn't report its version."],
    ['opencode changed since oc passed the ask-mode check.', 'The CLI version changed.'],
    ['claude changed since oc passed the ask-mode check.', 'The CLI version changed.'],
    ['oc failed the ask-mode check: a tool other than pacer\'s ran: bash, read', 'The ask-mode check failed.'],
    ['a tool other than pacer\'s ran: bash', 'The ask-mode check failed.'],
    ['a file outside the run directory was written', 'The ask-mode check failed.'],
    ['the planted file\'s contents came back', 'The ask-mode check failed.'],
    ['the agent attempted none of the denied tools', 'The ask-mode check failed.'],
    ['the agent did not attempt: bash', 'The ask-mode check failed.'],
    ['the agent returned no session to resume', 'The ask-mode check is incomplete.'],
    ['plugin timed out', 'The ask-mode check is incomplete.'],
  ];
  for (const [raw, plain] of cases) expect(askModeCheckCopy(raw)).toBe(plain);
  expect(isAskModeCheckReason('oc failed the ask-mode check: a tool other than pacer\'s ran: bash')).toBe(true);
  expect(isAskModeCheckReason('The assistant reached its limit of 50 turns today.')).toBe(false);
});

test("assistant live-tools phrases are shared for Settings and the sheet", () => {
  expect(executorAssistantDescription(false, false)).toBe("Needs the ask-mode check first.");
  expect(executorAssistantDescription(true, true)).toBe(`${ASSISTANT_LIVE_TOOLS_PHRASE} Slower; no extra key.`);
  expect(executorAssistantDescription(true, false)).toBe(`${ASSISTANT_SUMMARY_ONLY_PHRASE} Slower; no extra key.`);
  expect(executorSetupToolsCopy(true, "opencode")).toEqual({
    note: "checked · with pacer's live tools",
    title: ASSISTANT_LIVE_TOOLS_PHRASE,
  });
  expect(executorSetupToolsCopy(false, "claude-code")).toEqual({
    note: "checked · from pacer's summary",
    title: ASSISTANT_SUMMARY_ONLY_PHRASE,
  });
  expect(assistantBackendChoiceLabel("claude-code", "executor", "claude-code")).toBe("claude-code · via Claude Code");
  expect(assistantBackendChoiceLabel("codex", "executor", "codex")).toBe("codex · via Codex");
  expect(assistantBackendChoiceLabel("oc-glm", "executor", "opencode")).toBe("oc-glm · via OpenCode");
  expect(assistantBackendChoiceLabel("local", "pacer")).toBe("local · pacer's agent");
  expect(assistantBackendChoiceLabel("ep", "pacer", null, true)).toBe("ep (planner) · pacer's agent");
  expect(assistantCliName("claude-code")).toBe("Claude Code");
  expect(ASSISTANT_READS_SUMMARY_ONLY).toBe("The agent answers from pacer's summary only.");
});
