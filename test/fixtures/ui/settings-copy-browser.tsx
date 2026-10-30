import { render } from 'preact';
import { initialState } from '../../../app/src/data/store';
import { TaskContext } from '../../../app/src/screens/task-shared';
import { SetupEditor } from '../../../app/src/screens/settings/DispatcherSetup';
import { dispatchConfigSchema } from '../../../src/dispatch/types';
import fixture from './snapshot.json';

const snapshot = structuredClone(fixture);
const executor = {...snapshot.executors[0]!, enabled:true, stale:false, state:'ready', eligibility:{state:'uncertain',reasons:[{code:'availability_unknown',evidenceIds:[]}],evaluatedAt:snapshot.at,evidenceAgeS:null}};
const view = {strategy:'default',planner:'codex',plannerAccount:'codex',source:'built-in' as const,config:dispatchConfigSchema.parse({})};
render(<TaskContext.Provider value={{state:{...initialState(),snapshot:{...snapshot,executors:[executor]}} as any,api:{} as any}}><SetupEditor view={view} eligibility={{kind:'global',rules:[{executors:[executor.id]}],available:[executor.id]}} onSaved={()=>{}} onDirtyChange={()=>{}}/></TaskContext.Provider>,document.getElementById('root')!);
