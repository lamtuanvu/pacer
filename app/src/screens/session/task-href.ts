/** Primary task links open the workspace while retaining the list scope. */
export const taskHref=(query='')=>(id:string)=>`#/workspace?task=${encodeURIComponent(id)}${query?`&${query.replace(/^\?/, '')}`:''}`;
