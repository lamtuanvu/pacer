import { expect, test } from 'bun:test';
import { createExecutorDraft, moveExecutor, validateExecutorDraft, isExecutorDraftDirty, executorSavePayload } from '../app/src/model/executor-settings';
const saved={revision:'v1',order:['codex','claude-code#second'],runners:[{id:'codex',enabled:true,maxTasks:1},{id:'claude-code#second',enabled:true,maxTasks:1}]};
test('draft edits do not mutate saved state and serialize as one batch',()=>{
 const draft=createExecutorDraft(saved);
 draft.runners.codex.maxTasks='2';draft.runners.codex.enabled=false;
 moveExecutor(draft,'claude-code#second',-1);
 expect(saved.order).toEqual(['codex','claude-code#second']);expect(saved.runners[0].maxTasks).toBe(1);
 expect(isExecutorDraftDirty(draft,saved)).toBe(true);
 expect(executorSavePayload(draft,saved)).toEqual({expectedRevision:'v1',order:['claude-code#second','codex'],runners:[{id:'claude-code#second',enabled:true,maxTasks:1},{id:'codex',enabled:false,maxTasks:2}]});
 expect(isExecutorDraftDirty(createExecutorDraft(saved),saved)).toBe(false);
});
for(const value of ['', '0','17','1.5','abc'])test(`invalid draft ${value} keeps its text and fails validation`,()=>{
 const draft=createExecutorDraft(saved);draft.runners.codex.maxTasks=value;
 expect(validateExecutorDraft(draft).codex).toBe('Enter a whole number from 1 to 16.');
 expect(draft.runners.codex.maxTasks).toBe(value);
 expect(()=>executorSavePayload(draft,saved)).toThrow();
});
test('boundary moves are noops; edit then revert is pristine',()=>{
 const draft=createExecutorDraft(saved);moveExecutor(draft,'codex',-1);
 expect(draft.order).toEqual(saved.order);
 draft.runners.codex.maxTasks='2';draft.runners.codex.maxTasks='1';
 expect(isExecutorDraftDirty(draft,saved)).toBe(false);
});
