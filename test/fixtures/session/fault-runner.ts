// Runs the session host with one injected fault, chosen by environment variables.
import { writeFileSync } from "node:fs";
import { sessionHost } from "../../../src/session/host";
import { SecretMasker } from "../../../src/session/masking";
const kind = process.env.FAULT_KIND, marker = process.env.FAULT_MARKER!, dir = process.env.SESSION_DIR!;
if (kind === "callback") {
  const originalPush = SecretMasker.prototype.push;
  SecretMasker.prototype.push = function () { SecretMasker.prototype.push = originalPush; writeFileSync(marker, "injected"); throw Error("callback fault"); };
} else setTimeout(() => { writeFileSync(marker, "injected"); if (kind === "exception") throw Error("async fault"); void Promise.reject(Error("rejection fault")); }, 200);
process.exit(await sessionHost(dir));
