import { useState } from "preact/hooks";
import { Pagination } from "../ds/Pagination";

export function useOverviewPage<T>(rows: readonly T[], label: string, pageSize: number, scope = "") {
  const [position, setPosition] = useState({ scope, page: 0 });
  const page = Math.max(0, Math.min(position.scope === scope ? position.page : 0, Math.ceil(rows.length / pageSize) - 1));
  // Persist clamping/reset so a later snapshot cannot jump back to an obsolete page.
  if (position.scope !== scope || position.page !== page) setPosition({ scope, page });
  return {
    rows: rows.slice(page * pageSize, (page + 1) * pageSize),
    footer: <Pagination label={label} page={page} pageSize={pageSize} total={rows.length}
      onChange={next => setPosition({ scope, page: next })} />,
  };
}
