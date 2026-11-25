import { beginAdoption, readAdoption } from "../../../src/update/desktop/adoption-store";
import type { Ctx } from "../../../src/types";
import type { Installation } from "../../../src/update/desktop/types";

const [home, mode, requestId = "adopt-cross"] = process.argv.slice(2) as string[];
const installationId = "attached";
const ctx = { pacerHome: home } as Ctx;

const target: Installation = {
  id: installationId,
  appPath: "/tmp/pacer.app",
  bundleId: "dev.pacer.desktop",
  ownerUid: process.getuid?.() ?? 0,
  arch: "aarch64",
  pacerHome: home,
  port: 7433,
  serviceLabel: "com.pacer.serve",
  ownership: "attached",
  version: "1.0.0",
};
const authority = {
  target,
  nativeSessionId: "native",
  desktopClientId: "desktop",
  bootId: "boot",
  desktop: { pid: 101, bootId: "boot", birth: "1:1" },
  service: { pid: 102, bootId: "boot", birth: "1:2" },
  serviceVersion: "1.0.0",
  oldServiceExecutable: "/opt/pacer",
  newServiceExecutable: "/tmp/pacer.app/Contents/Resources/pacer",
};

if (mode === "begin") {
  console.log(
    JSON.stringify(
      beginAdoption(ctx, { installationId, requestId, expectRevision: 0 }, authority),
    ),
  );
} else {
  const value = readAdoption(ctx, installationId);
  console.log(JSON.stringify(value));
}