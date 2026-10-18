import {expect,test} from 'bun:test';
import {options} from 'preact';
import {renderToString} from 'preact-render-to-string';
import {OverviewView} from '../app/src/screens/Overview';
import {SessionsList} from '../app/src/screens/session/SessionsList';
import {createActionRunner} from '../app/src/data/actions';
import snapshot from './fixtures/ui/snapshot.json';
import fixture from './fixtures/ui/session.json';
import type {ClientSnapshot} from '../src/view-model/snapshot';
import type {SessionData} from '../app/src/screens/session/types';

test('both running lists dispatch takeover and navigate through the row button',async()=>{
 for(const overview of [true,false]){
  const calls:unknown[]=[],routes:string[]=[],clicks:(()=>void)[]=[];
  const runner=createActionRunner({call:async<T,>(op:string,params:unknown)=>{calls.push([op,params]);return {state:'driving'} as T;},navigate:hash=>routes.push(hash),refetch:()=>{},waitFor:async()=>true});
  const previous=options.vnode;
  options.vnode=node=>{previous?.(node);if(node.type==='button'&&(node.props as any).children==='Take over')clicks.push((node.props as any).onClick);};
  let html:string;
  try{html=renderToString(overview?<OverviewView snapshot={snapshot as unknown as ClientSnapshot} query={{repo:null,scope:null}} now={snapshot.at} runner={runner} activity={[]} ops={new Set()}/>:<SessionsList running={{data:[fixture as SessionData,{...fixture,id:'queued',state:'queued'} as SessionData]}} recent={{data:[{...fixture,id:'ended',state:'done'} as SessionData]}} runner={runner}/>);}
  finally{options.vnode=previous;}
  expect(clicks).toHaveLength(overview?snapshot.tasks.filter(t=>t.state==='running').length:1);
  expect(html!).toContain('pc-btn--secondary');
  clicks[0]!();await Promise.resolve();await Promise.resolve();
  expect(calls).toEqual([['task.takeover',{id:overview?snapshot.tasks.find(t=>t.state==='running')!.id:'t-0415'}]]);
  expect(routes).toEqual([overview?`#/sessions/${snapshot.tasks.find(t=>t.state==='running')!.id}?takeover=driving`:'#/sessions/t-0415?takeover=driving']);
 }
});
