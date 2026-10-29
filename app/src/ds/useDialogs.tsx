import { Field, TextArea } from "./Controls";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

export interface DialogRequest { message: string; title: string; label: string; text?: boolean }
/** Shared content keeps confirmation and required text entry inside the app. */
export function DialogForm({ request, value, change, finish }: {
  request: DialogRequest; value: string; change: (value: string) => void; finish: (result: string | boolean | null) => void;
}) {
  const cancel = () => finish(request.text ? null : false);
  return <Dialog title={request.title} close={cancel} showClose={false}>
    <form className="pc-form" onSubmit={event => {
      event.preventDefault();
      if (request.text && !value.trim()) return;
      finish(request.text ? value.trim() : true);
    }}>
      <p className="pc-dialog-message">{request.message}</p>
      {request.text && <Field label="Rejection note"><TextArea required autoFocus value={value} onInput={event => change(event.currentTarget.value)} /></Field>}
      <div className="row-actions">
        <Button autoFocus={!request.text} onClick={cancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={request.text && !value.trim()}>{request.label}</Button>
      </div>
    </form>
  </Dialog>;
}

/** One pending request per owner; dismissal and unmount always cancel it. */
export function useDialogs() {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const [value, setValue] = useState('');
  const active = useRef(true);
  const pending = useRef<{ resolve: (value: string | boolean | null) => void; text?: boolean }>();
  useEffect(() => () => {
    active.current = false;
    const current = pending.current;
    pending.current = undefined;
    current?.resolve(current.text ? null : false);
  }, []);
  const finish = (result: string | boolean | null) => {
    const current = pending.current;
    pending.current = undefined;
    setRequest(null);
    current?.resolve(result);
  };
  const ask = (next: DialogRequest): Promise<string | boolean | null> => {
    if (!active.current || pending.current) return Promise.resolve(next.text ? null : false);
    setValue('');
    setRequest(next);
    return new Promise(resolve => { pending.current = { resolve, text: next.text }; });
  };
  return {
    confirm: async (message: string, title = 'Confirm action', label = 'Confirm') =>
      (await ask({ message, title, label })) === true,
    prompt: async (message: string) => await ask({ message, title: 'Rejection note', label: 'Continue', text: true }) as string | null,
    dialog: request && <DialogForm request={request} value={value} change={setValue} finish={finish} />,
  };
}
