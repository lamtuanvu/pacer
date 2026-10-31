import {expect, test} from 'bun:test';
import {renderToString} from 'preact-render-to-string';
import fixture from './fixtures/ui/task-get.json';
import type {TaskDetail} from '../src/core/task-detail';
import {CostTiles, NowCard} from '../app/src/screens/trace/Overview';

const task = (overrides: Partial<TaskDetail> = {}): TaskDetail => ({...fixture, state:'done', review:null, files:[], ...overrides} as TaskDetail);

test('unavailable diff never becomes zero line totals or a completed file count', () => {
 const t = task({derived:{files:'unavailable'} as TaskDetail['derived']});
 for (const compact of [false, true]) {
  const cost = renderToString(<CostTiles task={t} compact={compact}/>);
  if (compact) {
   expect(cost).toContain('Some task metrics are unavailable.');
   expect(cost).not.toContain('Changed');
  } else {
   expect(cost).toContain('Not recorded');
   expect(cost).not.toContain('+0');
   expect(cost).not.toContain('−0');
  }
  const now = renderToString(<NowCard task={t} compact={compact}/>);
  expect(now).toContain('Changes unavailable');
  expect(now).not.toContain('0 files');
 }
});

test('successful empty diff preserves genuine zero counts', () => {
 const t = task({derived:{files:'ready'} as TaskDetail['derived']});
 const cost = renderToString(<CostTiles task={t}/>);
 expect(cost).toContain('0 files');
 expect(cost).toContain('+0 −0');
 expect(renderToString(<NowCard task={t}/>)).toContain('0 files changed');
});

test('running file count uses recorded progress including zero, then only an available diff', () => {
 for (const files of [undefined, 0, 3]) {
  const t = task({state:'running', progress: files === undefined ? undefined : {phase:'editing',lastOutputAt:null,files,commits:0,logBytes:0}, derived:{files:'unavailable'} as TaskDetail['derived']});
  const now = renderToString(<NowCard task={t} compact/>);
  if (files === undefined) {
   expect(now).not.toContain('touched so far');
   expect(now).not.toContain('files changed');
  } else {
   expect(now).toContain(`${files} files touched so far`);
  }
 }
 const available = task({state:'running', progress:undefined, derived:{files:'ready'} as TaskDetail['derived']});
 expect(renderToString(<NowCard task={available} compact/>)).toContain('0 files touched so far');
});

test('legacy detail without derived metadata retains supplied counts', () => {
 const t = task({derived:undefined, files:[{path:'result.ts',added:7,removed:2,status:'modified',binary:false}]});
 expect(renderToString(<CostTiles task={t}/>)).toContain('+7 −2');
 expect(renderToString(<NowCard task={t}/>)).toContain('1 files changed');
});

test('Now distinguishes account names from the agent name without repeating default identities', () => {
 for (const account of ['codex', 'Codex', 'unknown']) {
  const t = task({state:'running', executor:'codex', cost:{executor:{account,deltaPct:null,window:null},planner:null}});
  const html = renderToString(<NowCard task={t} compact/>);
  expect(html).not.toMatch(/Codex · (?:codex|unknown)/i);
 }
 const t = task({state:'running', executor:'codex#team', cost:{executor:null,planner:null}});
 expect(renderToString(<NowCard task={t} compact/>)).toContain('Codex · team');
});
