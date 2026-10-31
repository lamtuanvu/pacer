import { ImmediateSetting } from "./ImmediateSetting";
import { Switch } from "../../ds/Controls";
/** Older services omit session; capability follows the response, not a guessed version. */
export function hostSessionAction(alias:string,enabled:boolean) {
 return {label:'Full live sessions',op:'host.set',params:{alias,session:enabled?'full':'recording'}};
}
export function HostSessionSwitch({alias,host,disabled,run,onSaved}:{alias:string;host:object;disabled?:boolean;run:(op:string,params:unknown)=>unknown;onSaved?:()=>void}) {
 if(!('session' in host))return null;
 return <ImmediateSetting value={host.session==='full'} operation={enabled => hostSessionAction(alias,enabled)} onSaved={onSaved}>{(value, change, busy) => <Switch label={<strong>Full live sessions</strong>} help="Allow live terminal control for sessions on this host." aria-label="Full live sessions" checked={value} disabled={disabled||busy} onChange={event => change(event.currentTarget.checked)}/>}</ImmediateSetting>;
}
