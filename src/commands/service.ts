import { serviceCli, SERVICE_USAGE } from "../service/cli";
import type { Command } from "./types";
export const COMMANDS: Command[] = [{ name: "service", usage: SERVICE_USAGE, run: serviceCli }];
