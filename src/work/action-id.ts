export const workActionRequestId = (taskId: string, rev: number, kind: "retry" | "answer") => `${taskId}.${rev}.${kind}`;
