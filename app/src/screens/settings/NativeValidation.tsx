import {useState} from "preact/hooks";
import {createValidationIpc,type NativeValidationSetupResult} from "../../desktop/validation";
import {Button} from "../../ds/Button";
import {SectionHeading} from "../../ds/SectionHeading";
import {ErrorMessage} from "../task-shared";
const messages:Partial<Record<NativeValidationSetupResult["status"],string>>={
  already_open:"Setup is already open beside Settings.",
  verified:"Native access verified.",
  cancelled:"Setup cancelled.",
};
export function NativeValidationSetup() {
  const ipc=createValidationIpc();
  const [state,setState]=useState<{busy?:boolean;message?:string;error?:unknown}>({});
  if(!ipc.supported)return null;
  const setup=async()=>{
    if(state.busy)return;
    setState({busy:true});
    try{const result=await ipc.setup();setState({message:messages[result.status]??"Access was not verified. Reopen setup to try again."});}catch(error){setState({error});}
  };
  return <div>
    <div className="u3-setting"><div><SectionHeading>Native validation</SectionHeading><p>Enable macOS access for native controls and VoiceOver.</p></div>
      <Button disabled={state.busy} aria-describedby="native-validation-status" onClick={()=>void setup()}>{state.busy?"Setup open…":"Enable native checks"}</Button>
    </div>
    <p id="native-validation-status" role="status" aria-live="polite">{state.busy?"Drag the app into the list in Settings, then enable it. Pacer will verify access.":state.message??"Open setup to enable macOS access."}</p>
    <ErrorMessage error={state.error}/>
  </div>;
}
