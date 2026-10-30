// Captured from v0.10.0:src/session/attach.ts by scripts/upgrade-fixtures.ts.
export const oldCliHello = (stdout: {columns?: number; rows?: number} = {}) => ({v:1,client:"cli",label:process.env.TERM_PROGRAM??process.env.TERM??"cli",cols:stdout.columns ?? 120,rows:stdout.rows ?? 40});
