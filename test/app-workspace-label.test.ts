import { expect, test } from 'bun:test';
import { workspaceSessionLabel, workspaceAgentLabel, latestWorkspaceTask } from '../app/src/screens/workspace/session-label';

test('task-owned sessions prefer complete task identity over executor', () => {
  expect(workspaceSessionLabel({executor:'codex',fullTitle:'Full task name',title:'Compact…',goal:'Brief'})).toBe('Full task name');
  expect(workspaceSessionLabel({executor:'codex',title:'Fix tabs',goal:'Brief'})).toBe('Fix tabs');
  expect(workspaceSessionLabel({executor:'codex',goal:'Legacy task'})).toBe('Legacy task');
  expect(workspaceSessionLabel({executor:'codex',title:'Other task'})).toBe('Other task');
});

test('unassigned and missing tasks retain useful fallbacks', () => {
  expect(workspaceSessionLabel({executor:null,title:'Queued task'})).toBe('Queued task');
  expect(workspaceSessionLabel({executor:'codex#work@remote'})).toBe('Codex · work on remote');
  expect(workspaceSessionLabel(undefined)).toBe('Task');
});

test('agent tabs identify owning task and executor session ordinal', () => {
  expect(workspaceAgentLabel({title:'Fix tabs'}, {executor:'codex',ordinal:2})).toBe('Fix tabs · Codex · Session 2');
  expect(workspaceAgentLabel({fullTitle:'Other task',title:'Other…'}, {executor:'codex',ordinal:1})).toBe('Other task · Codex · Session 1');
  expect(workspaceAgentLabel(undefined, {executor:'codex',ordinal:1})).toBe('Task · Codex · Session 1');
});

test('restored generic panels render current names in tabs, tooltips and close controls', async () => {
  const { h } = await import('preact');
  const { renderToString } = await import('preact-render-to-string');
  const { ViewActive } = await import('../app/src/workspace/state');
  const { Workspace } = await import('../app/src/screens/workspace/Workspace');
  const { TaskContext } = await import('../app/src/screens/task-shared');
  const { initialState } = await import('../app/src/data/store');
  const { workspaceManager, workspaceKey } = await import('../app/src/workspace/manager');
  const fixture = (await import('./fixtures/ui/snapshot.json')).default;
  const key = workspaceKey('pending', 'label-task');
  workspaceManager.set(key, 'panels', [{id:'session:label-task',task:'label-task',kind:'session',title:'Task workspace'}]);
  workspaceManager.set(key, 'activePanel', 'session:label-task');
  const api = {call: async () => ({})} as never;
  try {
    for (const title of ['First task name', 'Renamed task']) for (const executor of ['codex','unknown']) {
      const state = {...initialState(),snapshot:{...fixture,tasks:[{...fixture.tasks[0],id:'label-task',executor,fullTitle:title,title:'Compact'}]}} as never;
      const html = renderToString(h(TaskContext.Provider, {value:{state,api}}, h(ViewActive.Provider, {value:false}, h(Workspace, {id:'label-task',query:{repo:null,scope:null}}))));
      expect(html).toContain(`title="${title}"`);
      expect(html).toContain(`aria-label="Close ${title}"`);
      expect(html).not.toContain('Task workspace');
      expect(html).toContain(`pc-agent-mark--${executor}`);
      expect(html).toContain(`aria-label="${executor==='codex'?'Codex':'unknown'}"`);
      expect(html).toContain(`class="pc-terminal-tab-text">${title}</span>`);
    }
  } finally { workspaceManager.clearIdentity('pending'); }
});


test('labels use the newest task revision and prefer authoritative reads on ties', () => {
  const owner = {title:'Old owner',rev:1};
  const snapshot = {title:'Renamed task',rev:2};
  const detail = {title:'Newest detail',rev:3};
  expect(workspaceSessionLabel(latestWorkspaceTask(snapshot, owner))).toBe('Renamed task');
  expect(workspaceAgentLabel(latestWorkspaceTask(snapshot, owner), {executor:'codex',ordinal:2})).toBe('Renamed task · Codex · Session 2');
  expect(workspaceSessionLabel(latestWorkspaceTask(snapshot, detail, owner))).toBe('Newest detail');
  expect(workspaceSessionLabel(latestWorkspaceTask(snapshot, {...owner,rev:2}))).toBe('Renamed task');
});
