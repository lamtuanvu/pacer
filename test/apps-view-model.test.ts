import { expect, test } from "bun:test";
import type { AppStatus } from "../src/apps/types";
import { appsCardFocusKey, appsCardShouldMoveFocus, appsCardView, appsPageView } from "../src/view-model/apps";

const base: AppStatus = {
  id: "orca",
  name: "Orca",
  description: "desc",
  additions: ["Sidebar panel"],
  panelDir: "/tmp/orca-panel",
  oldPlugin: false,
  presence: { kind: "ready", hostVersion: "Orca 1.4 is running" },
  getUrl: "https://example.com",
};

test("appsCardView covers every board phase", () => {
  expect(appsCardView({ ...base, presence: { kind: "not_found" } }).phase).toBe("not_found");
  expect(appsCardView({ ...base, presence: { kind: "missing_files", reason: "missing" } }).phase).toBe("missing_files");
  expect(appsCardView(base).phase).toBe("ready");
  expect(
    appsCardView(base, { approval: { fingerprint: "ap1", grants: [{ kind: "storage:own", what: "w", why: "y", icon: "i" }] } }).phase,
  ).toBe("approving");
  expect(
    appsCardView({
      ...base,
      presence: { kind: "added", installedVersion: "0.1.0", updateAvailable: false },
    }).pill,
  ).toEqual({ label: "Added · 0.1.0", tone: "good" });
  const update = appsCardView({
    ...base,
    presence: { kind: "added", installedVersion: "0.1.0", bundledVersion: "0.2.0", updateAvailable: true },
  });
  expect(update.phase).toBe("update");
  expect(update.updateLabel).toBe("Update to 0.2.0");
  const failed = appsCardView(base, { error: "expired" });
  expect(failed.phase).toBe("failed");
  expect(failed.terminalCommands?.install).toContain("/tmp/orca-panel");
});

test("appsPageView labels available count and trust caption", () => {
  const page = appsPageView([base]);
  expect(page.availableLabel).toBe("Available · 1");
  expect(page.trustCaption).toContain("only after you confirm");
});

test("empty grants never enter approving — failed with the no-grants board reason and terminal fallback", () => {
  const card = appsCardView(base, { approval: { fingerprint: "ap-empty", grants: [] } });
  expect(card.phase).toBe("failed");
  expect(card.error).toBe(
    "Orca didn’t say what it would allow, so pacer won’t ask you to approve it here.",
  );
  expect(card.grants).toBeUndefined();
  expect(card.fingerprint).toBeUndefined();
  expect(card.terminalCommands?.install).toContain("/tmp/orca-panel");
  expect(card.pill).toEqual({ label: "Couldn't add", tone: "bad" });
});

test("stale approval re-shows grants with the board expired status line", () => {
  const grants = [{ kind: "storage:own", what: "w", why: "y", icon: "i" }];
  const card = appsCardView(base, { approval: { fingerprint: "ap-new", grants, stale: true } });
  expect(card.phase).toBe("approving");
  expect(card.expired).toBe(true);
  expect(card.grants).toEqual(grants);
  expect(card.fingerprint).toBe("ap-new");
  expect(appsCardView(base, { approval: { fingerprint: "ap1", grants } }).expired).toBeFalsy();
});

test("focus moves into a card only after its state changed and only from inside it or the body", () => {
  const ready = appsCardFocusKey({ phase: "ready", expired: false });
  const approving = appsCardFocusKey({ phase: "approving", expired: false });
  const expired = appsCardFocusKey({ phase: "approving", expired: true });
  expect(appsCardShouldMoveFocus(ready, approving, "body")).toBe(true);
  expect(appsCardShouldMoveFocus(ready, approving, "inside")).toBe(true);
  expect(appsCardShouldMoveFocus(ready, approving, "elsewhere")).toBe(false);
  expect(appsCardShouldMoveFocus(approving, approving, "body")).toBe(false);
  expect(appsCardShouldMoveFocus(approving, expired, "inside")).toBe(true);
});
