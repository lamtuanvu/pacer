import { Switch } from "../../ds/Controls";
/** Older services omit session; capability follows the response, not a guessed version. */
export function hostSessionAction(alias:string,enabled:boolean) {
 return {label:'Full live sessions',op:'host.set',params:{alias,session:enabled?'full':'recording'}};
}
export function HostSessionSwitch({alias,host,disabled,run}:{alias:string;host:object;disabled?:boolean;run:(op:string,params:unknown)=>unknown}) {
 if(!('session' in host))return null;
 return <Switch label={<strong>Full live sessions</strong>} help="Allow live terminal control for sessions on this host." aria-label="Full live sessions" checked={host.session==='full'} disabled={disabled} onChange={event=>{const action=hostSessionAction(alias,event.currentTarget.checked);void run(action.op,action.params);}}/>;
}
