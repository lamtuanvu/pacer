import { h, render } from 'preact';
import { TaskContext, useQuery } from '../../app/src/screens/task-shared';
import { initialState } from '../../app/src/data/store';
import { LazyWork } from '../../app/src/screens/work/LazyWork';
const root = document.getElementById('app')!;
const pending: ((data:string)=>void)[] = [];
let state = {...initialState(),connected:true};
const api = {call:()=>new Promise<string>(resolve=>pending.push(resolve))};
const renders:unknown[]=[];
function Consumer() { const query=useQuery<string>('task.get',{id:'one'}); renders.push({data:query.data,updating:query.updating}); return h('p',{},query.data??'EMPTY'); }
function mount() { render(h(TaskContext.Provider,{value:{state,api:api as never}},h(Consumer,{})),root); }
Object.assign(window,{cacheFirst:{pending,renders,mount,unmount:()=>render(null,root),connection:(connected:boolean)=>{state={...state,connected,connectionRevision:state.connectionRevision+(connected ? 1 : 0)};mount();},lazy:()=>render(h(LazyWork,{id:'one'}),root)}});
mount();
