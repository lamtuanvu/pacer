/** What a client holds. The service types make the read-model fields required; a client may still be talking to a 2.0 service that sends none of them. */
import type { LinkSnapshot, TaskData } from "../link/envelope";
import type { MachineCapacity, ReadModelFields, TaskDataV2 } from "../api/read-model/types";
export type ClientTask = TaskData & Partial<TaskDataV2>;
/** A 3.0 service sends the machine row without hardCap and unlimited; read the cap with machineHardCap. */
export type ClientMachine = Omit<MachineCapacity, "hardCap" | "unlimited"> & Partial<Pick<MachineCapacity, "hardCap" | "unlimited">>;
export type ClientSnapshot = Omit<LinkSnapshot, "tasks" | "attention" | "counts"> & Omit<Partial<ReadModelFields>, "machine"> & { tasks: ClientTask[]; machine?: ClientMachine };
