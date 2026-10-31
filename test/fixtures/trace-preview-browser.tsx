import { render } from 'preact';
import detail from './ui/task-get.json';
import { NowCard } from '../../app/src/screens/trace/Overview';
import { TaskContext } from '../../app/src/screens/task-shared';
import { initialState } from '../../app/src/data/store';
const settings = (window as any).SETTINGS;
const calls: string[] = (window as any).CALLS = [];
const task = {...detail, state:'running', review:null, acceptance:{state:'pending'}, ...settings.task};
const api = {async call(op:string) {
  calls.push(op);
  if (op === 'task.session') {
    if (settings.error) throw Error('unavailable');
    return {host:'builtin',attempt:1,cols:80,rows:24,live:true,capabilities:{snapshot:true},attach:{ws:'/raw-session'},...settings.session};
  }
  if (op === 'task.log') { if (settings.error) throw Error('unavailable'); return {stdout:settings.log ?? 'Headless output',stderr:''}; }
  throw Error(`Unexpected ${op}`);
}};
render(<TaskContext.Provider value={{api:api as any,state:initialState()}}><NowCard task={task as any} compact={settings.compact}/></TaskContext.Provider>, document.getElementById('app')!);
