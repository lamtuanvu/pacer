/** Diagnostics restart-wait fixture: the section alone, with ops answered by a local server.
 * ?restartWaitMs=<ms> shortens the restart wait (RESTART_WAIT) for the timeout test. */
import { render } from 'preact';
import { DiagnosticsSection, RESTART_WAIT } from '../../app/src/screens/settings/Diagnostics';
import { TaskContext } from '../../app/src/screens/task-shared';
import { ActionContext } from '../../app/src/data/action-context';
import { createActionRunner } from '../../app/src/data/actions';
import { initialState } from '../../app/src/data/store';
import { ApiError, type BrowserApi } from '../../app/src/data/api';

const waitMs=new URLSearchParams(location.search).get('restartWaitMs');
if (waitMs) RESTART_WAIT.timeoutMs = Number(waitMs);

const call: BrowserApi['call'] = async <T,>(op: string, params: unknown) => {
 const response = await fetch(`/ops/${op}`, {method:'POST',body:JSON.stringify(params)});
 const data = await response.json();
 if (!response.ok) throw new ApiError(data.code, data.message, data.hint);
 return data as T;
};
const api = {call} as BrowserApi;
const runner = createActionRunner({call,waitFor:async()=>true,refetch:()=>{},navigate:hash=>{location.hash=hash;}});
render(<TaskContext.Provider value={{state:initialState(),api}}><ActionContext.Provider value={runner}><DiagnosticsSection/></ActionContext.Provider></TaskContext.Provider>, document.getElementById('root')!);
