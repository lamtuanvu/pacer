/** The task route link for a card or row, carrying the list's query (repository scope) along. */
export const taskHref=(query='')=>(id:string)=>`#/tasks/${encodeURIComponent(id)}${query?(query.startsWith('?')?query:`?${query}`):''}`;
