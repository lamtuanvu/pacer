import type { Account } from "../../model/accounts";
import type { ConfigData } from "../../model/strategy";

export interface AgentsTabProps {
  /** The selected agent (runner id); the first agent when absent or unknown. */
  agent?: string;
  /** An account no agent uses, shown on its own (takes precedence over `agent`). */
  account?: string;
  initialAccounts?: Account[];
  initialConfig?: ConfigData;
}
