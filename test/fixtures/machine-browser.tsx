import { NotificationProvider } from '../../app/src/data/notification-context';
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { MachineSection } from '../../app/src/screens/settings/General';
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
// Tests call window.invalidateConfig() to stand in for the config event another client's change publishes.
function Root() {
 const [config, setConfig] = useState(0);
 (window as unknown as {invalidateConfig: () => void}).invalidateConfig = () => setConfig(n => n + 1);
 return <TaskContext.Provider value={{state:{...initialState(),invalidations:{config}},api}}><ActionContext.Provider value={runner}><NotificationProvider><MachineSection/></NotificationProvider></ActionContext.Provider></TaskContext.Provider>;
}
render(<Root/>, document.getElementById('root')!);
