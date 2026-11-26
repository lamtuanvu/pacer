import type { Account } from "../../model/accounts";
import type { ConfigData } from "../../model/strategy";

export interface AgentsTabProps {
  /** The selected agent (runner id); the first agent when absent or unknown. */
  agent?: string;
  initialAccounts?: Account[];
  initialConfig?: ConfigData;
}
