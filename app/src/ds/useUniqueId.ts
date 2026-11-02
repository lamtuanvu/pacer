import { useId, useRef } from 'preact/hooks';
let instance = 0;
/** Preact portal roots have separate useId counters; the suffix spans all roots in this client. */
export function useUniqueId() {
 const root = useId(), id = useRef<string>();
 return id.current ??= `${root}-${++instance}`;
}
