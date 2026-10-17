/** What a client holds. The service types make the read-model fields required; a client may still be talking to a 2.0 service that sends none of them. */
import type { LinkSnapshot, TaskData } from "../link/envelope";
import type { ReadModelFields, TaskDataV2 } from "../api/read-model/types";
export type ClientTask = TaskData & Partial<TaskDataV2>;
export type ClientSnapshot = Omit<LinkSnapshot, "tasks" | "attention" | "counts"> & Partial<ReadModelFields> & { tasks: ClientTask[] };
