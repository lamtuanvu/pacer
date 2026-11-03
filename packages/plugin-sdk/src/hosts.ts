import type { HostRunnerRunInput, HostRunnerRunResult, HostRunnerSession } from "./host-runner";

type Call = <T = unknown>(method: string, params: unknown) => Promise<T>;
export interface HostFetchInput { session: string; timeoutMs: number; maxBytes: number }

/** Plugin-side wrapper; the host broker owns session admission and revocation. */
export function createHosts(call: Call) {
  return {
    open(alias: string): Promise<HostRunnerSession> {
      return call("capability.hosts.open", { alias });
    },
    run(input: HostRunnerRunInput): Promise<HostRunnerRunResult> {
      return call("capability.hosts.run", input);
    },
    fetch(input: HostFetchInput): Promise<{ ok: true }> {
      return call("capability.hosts.fetch", input);
    },
    close(session: string): Promise<{ ok: true }> {
      return call("capability.hosts.close", { session });
    },
  };
}
