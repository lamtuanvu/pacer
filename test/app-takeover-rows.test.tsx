import {expect,test} from 'bun:test';
import {options} from 'preact';
import {renderToString} from 'preact-render-to-string';
import {OverviewView} from '../app/src/screens/Overview';
import {SessionsList} from './fixtures/ui/sessions-list';
import {taskTree} from '../src/view-model/task-tree';
import {createActionRunner} from '../app/src/data/actions';
import snapshot from './fixtures/ui/snapshot.json';
import fixture from './fixtures/ui/session.json';
import type {ClientSnapshot} from '../src/view-model/snapshot';
import type {SessionData} from '../app/src/screens/session/types';

test('Overview takeover remains available while Tasks uses direct row navigation',async()=>{
 for(const overview of [true]){
  const calls:unknown[]=[],routes:string[]=[],clicks:(()=>void)[]=[];
  const runner=createActionRunner({call:async<T,>(op:string,params:unknown)=>{calls.push([op,params]);return {state:'driving'} as T;},navigate:hash=>routes.push(hash),refetch:()=>{},waitFor:async()=>true});
  const previous=options.vnode;
  options.vnode=node=>{previous?.(node);if(node.type==='button'&&(node.props as any).children==='Take over')clicks.push((node.props as any).onClick);};
  let html:string;
  try{html=renderToString(<OverviewView snapshot={snapshot as unknown as ClientSnapshot} query={{repo:null,scope:null}} now={snapshot.at} runner={runner} activity={[]} ops={new Set()}/>);}
  finally{options.vnode=previous;}
  expect(clicks).toHaveLength(overview?snapshot.tasks.filter(t=>t.state==='running').length:1);
  expect(html!).toContain('pc-btn--secondary');
  clicks[0]!();await Promise.resolve();await Promise.resolve();
  expect(calls).toEqual([['task.takeover',{id:overview?snapshot.tasks.find(t=>t.state==='running')!.id:'t-0415'}]]);
  expect(routes).toEqual([overview?`#/tasks/${snapshot.tasks.find(t=>t.state==='running')!.id}?takeover=driving`:'#/tasks/t-0415?takeover=driving']);
 }
 const list=renderToString(<SessionsList running={{data:taskTree({tasks:[{id:'t-0415',goal:(fixture as SessionData).goal,state:'running',executor:'codex',backend:null,worktree:null,updatedAt:1}]},{now:2})}}/>);
 expect(list).toContain('href="#/tasks/t-0415"');
 expect(list).not.toContain('Take over');
});
