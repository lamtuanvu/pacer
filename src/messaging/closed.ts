import type { TaskRecord } from "../tasks/types";

/** A closed task takes no more messages. */
export const isClosed = (t: TaskRecord) => !!t.review || !!t.dismissed || !!t.msgClosed || t.state === "stopped";
