/** Older services omit session; capability follows the response, not a guessed version. */
export function hostSessionAction(alias:string,enabled:boolean) {
 return {label:'Full live sessions',op:'host.set',params:{alias,session:enabled?'full':'recording'}};
}
export function HostSessionSwitch({alias,host,disabled,run}:{alias:string;host:object;disabled?:boolean;run:(op:string,params:unknown)=>unknown}) {
 if(!('session' in host))return null;
 return <label className="pc-checkbox"><div><strong>Full live sessions</strong><p className="u3-muted">Allow live terminal control for sessions on this host.</p></div><input className="pc-checkbox__input" type="checkbox" role="switch" aria-label="Full live sessions" checked={host.session==='full'} disabled={disabled} onChange={e=>{const action=hostSessionAction(alias,e.currentTarget.checked);void run(action.op,action.params);}}/></label>;
}
