import { Page } from '../../app/src/ds/Page';
import { DensityContext } from '../../app/src/ds/Density';
import { NotificationProvider } from '../../app/src/data/notification-context';
import { render } from 'preact';
import { DiagnosticsSection } from '../../app/src/screens/settings/Diagnostics';
import { TaskContext } from '../../app/src/screens/task-shared';
import { ActionContext } from '../../app/src/data/action-context';
import { createActionRunner } from '../../app/src/data/actions';
import { initialState } from '../../app/src/data/store';
import { ApiError, type BrowserApi } from '../../app/src/data/api';

const call: BrowserApi['call'] = async <T,>(op: string, params: unknown) => {
 const response = await fetch(`/ops/${op}`, {method:'POST',body:JSON.stringify(params)});
 const data = await response.json();
 if (!response.ok) throw new ApiError(data.code, data.message, data.hint);
 return data as T;
};
const api = {call} as BrowserApi;
const runner = createActionRunner({call,waitFor:async()=>true,refetch:()=>{},navigate:hash=>{location.hash=hash;}});
render(<TaskContext.Provider value={{state:initialState(),api}}><ActionContext.Provider value={runner}><NotificationProvider><DensityContext.Provider value="settings"><Page width="full" className="u3-settings"><DiagnosticsSection/></Page></DensityContext.Provider></NotificationProvider></ActionContext.Provider></TaskContext.Provider>, document.getElementById('root')!);
